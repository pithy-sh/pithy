// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { SettingsAccountReader, SettingsEnvironment } from "@pithy-sh/core/src/capability/settings";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import {
  loadProject,
  loadWorkerConfig,
  loadWorkerDomains,
  projectEnvironments,
  requireProjectName,
} from "../project/config";
import { type AddressStanza, resolveWorkerAddress } from "../project/workerAddress";
import { readOptionalWranglerConfig } from "../project/wrangler";
import { checkCapabilitySettings, type SettingsAccountConnection, type SettingsCheck } from "./settings";

/**
 * Where `pithy doctor`'s settings check gets the two things it cannot invent: the environments a capability
 * is judged against, and the account it may ask (#411).
 *
 * Split from `settings.ts` on purpose. That module is the runner — pure, seam-driven, and testable with no
 * project and no network. This one is the wiring: it reads the adopter's config off disk and opens a
 * Cloudflare client. Keeping them apart is what lets the three account outcomes (reached and clean, reached
 * and failing, never reached) be stated as three tests rather than as three mocks of a network.
 */

/**
 * The environments this project declares, and the origin the given Worker answers on in each.
 *
 * Both halves come from the readers that already own them — `loadProjectEnvironments` for the declared set,
 * `resolveWorkerAddress` for the address — so a capability's idea of "the origin for prod" is the same one
 * `pithy deploy` refuses on and the `Origins:` block reports. `dev` never resolves to a public address, and
 * an environment nothing serves carries `null` rather than being dropped: a check judging `BASE_URL` needs
 * to know the environment exists even when nothing declares where it answers.
 *
 * A `wrangler.jsonc` or a `pithy.config.ts` that will not read costs the origins and nothing else. The
 * declared set is the root config's, and without it there is no answer at all — which the runner turns
 * into an unchecked capability rather than into a clean pass.
 */
export async function settingsEnvironments(projectDir: string, workerDir: string): Promise<SettingsEnvironment[]> {
  const declared = await projectEnvironments(projectDir);
  const config = (await readOptionalWranglerConfig(workerDir).catch(() => null)) as {
    env?: Record<string, AddressStanza | undefined>;
  } | null;
  // A negative claim about a Worker's domains needs a config that was actually read: the `pithy.config.ts`
  // nobody could import is exactly the one that might have declared one.
  const domains = await loadWorkerConfig(workerDir)
    .then((worker) => loadWorkerDomains(worker))
    .catch(() => undefined);
  return declared.map((name) => {
    const address = resolveWorkerAddress({ environment: name, domains, stanza: config?.env?.[name] });
    return { name, origin: address?.url ?? null };
  });
}

/** What it takes to reach the account, all of it injectable so a unit test never calls out. */
export interface SettingsAccountOptions {
  /** The account this project belongs to, from its own root `pithy.config.ts`. */
  account: CloudflareAccountSelection | null;
  /** The root config's `name` — the leading segment of the manager Workflow a secret question is asked of. */
  project: string;
  /** Whether this run refuses ambient credentials and every network call. */
  offline: boolean;
  /** Environment overlay seam, so a test resolves credentials without a `.dev.vars`. */
  env?: NodeJS.ProcessEnv;
  /** Home directory seam — the credentials file is resolved under it, exactly as every other doctor path is. */
  homedir?: string;
  /** Cloudflare client seam. */
  connect?: (credentials: { accountId: string; apiToken: string }) => CloudflareClients;
  /** Secret-probe seam — the manager Workflow that answers whether a `d1` secret has a value. */
  probe?: (credentials: { accountId: string; apiToken: string }, project: string) => SecretProbe;
}

/**
 * Resolve the account the account tier asks, or the reason there is none to ask.
 *
 * **Four skips, and they are not one boolean.** `offline` is a decision somebody made and is settled first,
 * before any file is read. A pin the credentials contradict ends it as `unreachable` — the `Cloudflare:`
 * block of the same report already names that fault, and one fact belongs in one line. Credentials that
 * simply are not there are `no-credentials`, because a project that has not been provisioned yet is a
 * legitimate state and calling it unreachable would blame a network nobody touched.
 *
 * The reader memoizes: every composed capability asks the same account, and a doctor run must cost one
 * listing rather than one per capability.
 */
export async function settingsAccountConnection(options: SettingsAccountOptions): Promise<SettingsAccountConnection> {
  if (options.offline) return { state: "skipped", reason: "offline" };

  let vars: Record<string, string>;
  try {
    vars = cloudflareEnv({
      account: options.account,
      ...(options.env ? { env: options.env } : {}),
      ...(options.homedir ? { homedir: options.homedir } : {}),
    });
  } catch {
    return { state: "skipped", reason: "unreachable" };
  }
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return { state: "skipped", reason: "no-credentials" };

  const credentials = { accountId, apiToken };
  const clients = (options.connect ?? ((creds) => new CloudflareClients(creds)))(credentials);
  const probe = (
    options.probe ?? ((creds, project) => buildSecretDispatcher(creds.accountId, creds.apiToken, project))
  )(credentials, options.project);

  let databases: Promise<readonly string[]> | undefined;
  const zones = new Map<string, Promise<boolean>>();

  const reader: SettingsAccountReader = {
    d1Databases: () => {
      databases ??= clients
        .d1Provisioner()
        .listDatabases()
        .then((list) => list.map((entry) => entry.name));
      return databases;
    },
    zone: (hostname) => {
      const existing = zones.get(hostname);
      if (existing) return existing;
      const answer = clients
        .zones()
        .findZoneForHostname(hostname)
        .then((zone) => zone !== null);
      zones.set(hostname, answer);
      return answer;
    },
    // `async` so a refusal is a rejected promise rather than a synchronous throw: the runner guards both,
    // but a seam that throws before returning a promise is the shape `commands/doctor.ts` documents as the
    // one `.catch()` never sees, and no caller of this should have to know which it is.
    secret: async ({ name, environment }) => {
      // **`dev` is refused rather than answered.** A `d1` secret's value is sealed under a master key that
      // never leaves that environment's manager Worker, and `dev` has no manager — it is local Miniflare.
      // Answering `false` would report a signing key as missing on every developer's machine, which is a
      // fault nobody has and a report nobody would read twice.
      if (environment === "dev") {
        throw new InternalError({
          message: "A dev secret cannot be asked of the account.",
          action: "Ask about a deployed environment, or read the local value through pithy secrets edit.",
          detail: `secret ${name} in dev has no manager Worker to answer`,
        });
      }
      return probe.probe({ env: environment as "staging" | "prod", name });
    },
  };
  return { state: "reachable", reader };
}

/** One Worker as `pithy doctor` already holds it: its name, its directory, and what it composes. */
export interface SettingsWorkerScope {
  name: string;
  dir: string;
  capabilities: readonly Capability[];
}

/** What the default settings probe needs, all of it already resolved once by `buildDoctorReport`. */
export interface DoctorSettingsOptions {
  projectDir: string;
  /** The Workers in scope — already narrowed by `--worker`, so nothing here re-enumerates `apps/`. */
  workers: readonly SettingsWorkerScope[];
  /** The account this project belongs to, as the `Cloudflare:` block of the same report reads it. */
  account: CloudflareAccountSelection | null;
  /** Whether this run refuses ambient credentials and every network call. */
  offline: boolean;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `pithy doctor`'s settings probe, wired to a real project.
 *
 * **The declaration test comes before the project name**, and that order is the point: a project whose
 * capabilities declare no check has no settings question, and resolving a name it may not have would turn
 * that silence into a `could-not-check`. `requireProjectName` and not `resolveProjectName`, because the
 * name reaches an account resource name — `<project>-global-email-suppressions` — and a fallback-derived
 * one would have the check reporting a database missing that is sitting there under the real name.
 */
export async function doctorSettingsCheck(options: DoctorSettingsOptions): Promise<SettingsCheck | null> {
  if (!options.workers.some((worker) => worker.capabilities.some((capability) => capability.settings))) return null;
  const project = requireProjectName(await loadProject(options.projectDir));
  const dirs = new Map(options.workers.map((worker) => [worker.name, worker.dir]));
  return checkCapabilitySettings({
    project,
    workers: options.workers.map((worker) => ({ name: worker.name, capabilities: worker.capabilities })),
    environments: (worker) => settingsEnvironments(options.projectDir, dirs.get(worker) ?? options.projectDir),
    connect: () =>
      settingsAccountConnection({
        account: options.account,
        project,
        offline: options.offline,
        ...(options.homedir ? { homedir: options.homedir } : {}),
        ...(options.env ? { env: options.env } : {}),
      }),
  });
}
