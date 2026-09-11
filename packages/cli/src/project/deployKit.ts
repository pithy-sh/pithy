// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { messageOf, PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkerDomains } from "@pithy-sh/core/src/naming/domains";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import {
  deployHostWorker,
  kitPackageVersion,
  type ReadWorkerVars,
  type RunHostDeploy,
} from "../capabilities/hostDeploy";
import { hostTemplatePath, readHostTemplate as readHostTemplateDefault } from "../capabilities/hostRegistry";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { discoverHostWorkers, type HostWorker } from "../dev/hostWorkers";
import { isSourceEnvironment, wranglerConfigPath } from "../provision/featureConfig";
import { red } from "../terminal/style";
import { loadWorkerConfig, loadWorkerDomains } from "./config";
import { readOptionalFile } from "./readOptionalFile";
import { type AddressStanza, resolveWorkerAddress } from "./workerAddress";
import { discoverWorkers, type WorkerTarget } from "./workers";
import { readOptionalWranglerConfig } from "./wrangler";

/**
 * **The kit's own Workers, deployed by the same command that deploys the adopter's.**
 *
 * A deploy is a deploy: `pithy deploy` ships everything the project deploys, and half of that is
 * Workers the adopter never wrote — one per composed capability that owns Workflows. Until #537 the
 * only way to ship one was `pithy <capability> provision`, which also creates buckets, namespaces,
 * databases, secrets and Email Routing rules. Nobody wants that on every merge, so those Workers went
 * stale instead, silently, holding a theme and a base URL and a locale catalog nobody had touched
 * since the day they were provisioned.
 *
 * **This creates nothing.** Every binding id it needs is read off the project's own tracked
 * `wrangler.jsonc` files — the same read `assertEnvironmentProvisioned` makes — and the two
 * account-scoped ids that are not in the repository at all (`SECRETS_STORE_ID`,
 * `CLOUDFLARE_ACCOUNT_ID`) are read from the resolved credentials. Anything with no resource behind it
 * becomes a **skipped** row naming what to run, never a resource this run brings into existence.
 * `pithy provision` writes ids into the repository and a per-capability `provision` creates account
 * resources; neither belongs in a job that runs on every push.
 *
 * **The set is discovered by composition, forever.** {@link discoverHostWorkers} intersects each app
 * Worker's composed capabilities with the registry, which is how `pithy dev` finds the same set. A
 * capability added to a project joins with no CI change; a capability added to the kit joins with one
 * registry entry.
 *
 * **And the configuration is the adopter's, from that same discovery.** Reading `apps/` yields the
 * composed `Capability` objects, not just their names, so each host resolves against the project's own
 * `media({ recordStore: "kv" })` or `vector({ indexes })` — byte-identical to what
 * `pithy <capability> provision` would deploy. It did not, at first: five registry entries parsed
 * schema defaults, so this command and the provisioners deployed different configurations of the same
 * Worker and overwrote each other's (#537). `capabilities/hostRegistry.ts` is where that is now
 * impossible to reintroduce, and `hostConfigParity.test.ts` is what holds the two paths equal.
 *
 * **`env` is always a deployed environment, never `dev`.** A kit Worker in `dev` is `pithy dev`'s: it
 * is materialized under `.wrangler/pithy/hosts/` and run locally, which is also why
 * `resolveWorkerAddress` answers `null` for `dev` and `pithy <capability> provision` fans out over the
 * managed environments only. Handed `dev`, this pass would skip every host for having no address and
 * report a run that shipped nothing — so `commands/deploy.ts` does not call it there, and says so.
 */

/** What one kit Worker's deploy did. The `--json` row and the terminal line both read from this. */
export interface KitWorkerDeploy {
  /** The capability that owns the Worker — the row's label, and the key into the registry. */
  capability: string;
  /** The deployed script name, or `null` when this run never got far enough to derive one. */
  worker: string | null;
  /**
   * `deployed` — wrangler ran. `unchanged` — the stamp matched, so it did not.
   * `skipped` — this project cannot deploy it yet, and the reason names what to run.
   * `failed` — it was attempted and did not work.
   */
  outcome: "deployed" | "unchanged" | "skipped" | "failed";
  /** One sentence. Never empty: an outcome nobody can explain is the failure this issue is about. */
  reason: string;
}

/**
 * What the kit half of one deploy did: a row per capability, and anything that stopped it saying more.
 *
 * **The second half is not decoration, and it is not a note in the `pithy dev` sense.** Discovery has
 * two ways to come back short — an app Worker whose `pithy.config.ts` will not load (its capabilities
 * are invisible, so its hosts never enter the set) and a composition that will not assemble (no hosts
 * at all) — and a `KitWorkerDeploy` row cannot carry either, because neither names a capability. With
 * nowhere to put them this returned `[]`, `kitDeployFailed` read `false`, and `pithy deploy --env prod
 * --kit` printed nothing about the kit and exited 0: indistinguishable from a project that composes no
 * kit Worker. That is the silent staleness #537 exists to close, so a problem **fails the command**.
 * A skip is a fact about the project and names the command that answers it; a problem means this run
 * cannot say what it should have shipped.
 */
export interface KitDeployReport {
  /** One row per composed capability's Worker, in registry order. */
  workers: KitWorkerDeploy[];
  /** One sentence per thing that stopped this run knowing the set. Non-empty fails the command. */
  problems: string[];
}

/** Options for {@link deployKitWorkers}. */
export interface DeployKitOptions {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** The project name, from `requireProjectName`. The leading segment of every derived name. */
  project: string;
  /** The environment being deployed. Required: a kit Worker is per environment, always. */
  env: string;
  /** The account the project belongs to. Stated by the caller, never defaulted (#206). */
  account: CloudflareAccountSelection | null;
  /** Ship every kit Worker regardless of its stamp. */
  force?: boolean;
  /** Test seam: the app Workers. Defaults to `discoverWorkers`. */
  workers?: readonly WorkerTarget[];
  /** Test seam: the capabilities one Worker composes. Defaults to loading its `pithy.config.ts`. */
  capabilitiesFor?: (workerDir: string) => Promise<Capability[]>;
  /** Test seam: read a capability's committed template. Defaults to the file beside its worker entry. */
  readTemplate?: (projectDir: string, entry: string) => Promise<WorkflowHostTemplate>;
  /** Test seam: read a deployed Worker's vars. Defaults to the account's Workers REST client. */
  readVars?: ReadWorkerVars;
  /** Test seam: run one deploy. Defaults to `wrangler deploy --config`. */
  runDeploy?: RunHostDeploy;
}

/** The `env.<name>` stanza slice this reads: the resource bindings, and whatever names an address. */
interface KitStanza extends AddressStanza {
  d1_databases?: { binding?: string; database_id?: string }[];
  kv_namespaces?: { binding?: string; id?: string }[];
}

/**
 * Whether a `database_id` is one wrangler would deploy against.
 *
 * The same rule `provision/unprovisioned.ts` reports by, because it is the same question asked one
 * step later: a scaffold leaves `<database_id>` behind and an adopter leaves `""`, both of which look
 * filled in to a truthiness check and neither of which is an id.
 */
function isId(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !/^<.+>$/.test(trimmed) && !/placeholder/i.test(trimmed);
}

/**
 * One Worker's stanza for this environment — the tracked `wrangler.jsonc` for a declared environment,
 * the generated config under `.wrangler/` for a feature.
 *
 * Provisioning writes a feature's ids into a generated config rather than into the tracked file
 * (#242), which is also why `pithy deploy` passes `--config` there. Reading the tracked file for a
 * feature would find placeholders and report every kit Worker as unprovisioned.
 */
async function stanzaFor(worker: WorkerTarget, env: string): Promise<KitStanza | undefined> {
  if (!isSourceEnvironment(env)) {
    const raw = await readOptionalFile(wranglerConfigPath(worker.dir, env));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as KitStanza;
    } catch {
      return undefined;
    }
  }
  const config = (await readOptionalWranglerConfig(worker.dir).catch(() => null)) as {
    env?: Record<string, KitStanza | undefined>;
  } | null;
  return config?.env?.[env];
}

/**
 * Every binding of one kind this environment has an id for, across the project's app Workers.
 *
 * One reader for both kinds because it is one rule twice: the id is read off the tracked stanza,
 * nothing is created to learn it, and the first declaration wins — exactly as two Workers declaring
 * `DB` are backed by one D1, and two declaring `MEDIA` by one namespace.
 */
function collectIds(stanzas: readonly KitStanza[], kind: "d1" | "kv"): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const stanza of stanzas) {
    const entries: { binding?: string; id?: string }[] =
      kind === "d1"
        ? (stanza.d1_databases ?? []).map((entry) => ({ binding: entry.binding, id: entry.database_id }))
        : (stanza.kv_namespaces ?? []);
    for (const entry of entries) {
      if (entry.binding && isId(entry.id) && ids[entry.binding] === undefined) ids[entry.binding] = entry.id as string;
    }
  }
  return ids;
}

/**
 * The public origin the composing app Worker answers on for this environment — what a callback link,
 * a tracked click and an unsubscribe URL in a message the kit Worker sends are built against.
 *
 * Through the one resolver, which prefers the `domains` declaration and falls back to the route and
 * then to `vars.BASE_URL`. `null` when the Worker declares no address at all, which is a skip rather
 * than a guess: a kit Worker resolved against an invented origin sends real links to nowhere.
 */
async function baseUrlFor(worker: WorkerTarget, env: string, stanza: KitStanza | undefined): Promise<string | null> {
  let domains: WorkerDomains | undefined;
  try {
    domains = loadWorkerDomains(await loadWorkerConfig(worker.dir));
  } catch {
    // A malformed declaration is `pithy doctor`'s sentence to say. Fall through to the route and var.
    domains = undefined;
  }
  return resolveWorkerAddress({ environment: env, domains, stanza })?.url ?? null;
}

/**
 * The reason a `failed` row carries.
 *
 * A `PithyError`'s **`message` and `action` both**, because the two failures that land here need
 * different halves of it: a `wrangler deploy` that exited non-zero is explained by its message, and a
 * capability whose package will not load is explained entirely by its action (`Run pithy add email.`).
 * Dropping either leaves one of them unactionable, and this row is the only place either is printed.
 *
 * `detail` is deliberately left out — it is the throw site's, for logs and audit (CLAUDE.md §Errors),
 * and wrangler's captured stderr is a paragraph rather than a row.
 */
function failureReason(error: unknown): string {
  if (!(error instanceof PithyError)) return messageOf(error);
  const { message, action } = error.payload;
  return action ? `${message} ${action}` : message;
}

/** The row a capability gets when this project cannot deploy its Worker yet. */
function skipped(capability: string, reason: string): KitWorkerDeploy {
  return { capability, worker: null, outcome: "skipped", reason };
}

/**
 * Deploy every composed capability's Worker for one environment, gated.
 *
 * One capability's failure does not abort the batch — every one is attempted and reported, exactly as
 * `deployProject` treats the adopter's Workers, so a caller can exit non-zero on the rows rather than
 * on the first throw.
 *
 * **And it does not throw, either.** It runs after the adopter's Workers have already shipped, so a
 * throw from the pass itself — `apps/` unreadable, a Worker named after a capability's host, an
 * account client that will not build — took the `--json` line down with it and left a CI step with no
 * `workers[]` payload for Workers that were already live. Every such failure is a problem on the
 * report instead, beside whatever rows the run had reached. `--json` prints, and the exit code still
 * says it failed.
 */
export async function deployKitWorkers(options: DeployKitOptions): Promise<KitDeployReport> {
  const workers: KitWorkerDeploy[] = [];
  const problems: string[] = [];
  try {
    await runKitDeploy(options, workers, problems);
  } catch (error) {
    problems.push(failureReason(error));
  }
  return { workers, problems };
}

/** The pass itself. Rows and problems are the caller's arrays, so a throw never loses what it reached. */
async function runKitDeploy(options: DeployKitOptions, rows: KitWorkerDeploy[], problems: string[]): Promise<void> {
  const workers = options.workers ?? (await discoverWorkers(options.projectDir));
  const { hosts, notes } = await discoverHostWorkers({
    projectDir: options.projectDir,
    workers,
    ...(options.capabilitiesFor ? { capabilitiesFor: options.capabilitiesFor } : {}),
  });
  // Every note is a Worker whose capabilities this run could not read, so it is a problem here rather
  // than the line `pithy dev` prints: the hosts that Worker composes are missing from the set below,
  // and nothing else would ever say so.
  problems.push(...notes);
  if (hosts.length === 0) return;

  const readTemplate = options.readTemplate ?? readHostTemplateDefault;
  const vars = cloudflareEnv({ account: options.account });
  const credentials =
    vars.CLOUDFLARE_ACCOUNT_ID && vars.CLOUDFLARE_API_TOKEN
      ? { accountId: vars.CLOUDFLARE_ACCOUNT_ID, apiToken: vars.CLOUDFLARE_API_TOKEN }
      : undefined;
  // No credentials means no stamp can be read, which the gate treats as doubt and therefore deploys —
  // wrangler still authenticates on its own OAuth login, exactly as `pithy deploy` always could.
  const readVars = options.readVars ?? (credentials ? await workersVarsReader(credentials) : undefined);

  const stanzas = new Map<string, KitStanza | undefined>();
  for (const worker of workers) stanzas.set(worker.dir, await stanzaFor(worker, options.env));
  const declared = [...stanzas.values()].filter((stanza) => stanza !== undefined);
  const databaseIds = collectIds(declared, "d1");
  const kvNamespaceIds = collectIds(declared, "kv");

  for (const host of hosts) {
    const source = workers.find((worker) => worker.dir === host.sourceDir);
    rows.push(
      await deployOneKitWorker({
        host,
        source,
        options,
        readTemplate,
        readVars,
        databaseIds,
        kvNamespaceIds,
        stanza: stanzas.get(host.sourceDir),
        storeId: vars.SECRETS_STORE_ID,
        accountId: vars.CLOUDFLARE_ACCOUNT_ID,
        credentials,
      }),
    );
  }
}

/**
 * The two account-scoped ids a kit Worker's config can carry, and what a Worker deployed without one
 * would actually be.
 *
 * **These are the readiness holes a `database_id` check cannot see.** A missing D1 id was already a
 * skip; `SECRETS_STORE_ID` and `CLOUDFLARE_ACCOUNT_ID` went through as `""` and the row printed
 * `deployed` — a Worker bound to `store_id: ""`, unable to read the master key that decrypts every
 * secret it holds, reported as a success (#537). Both are account-scoped rather than per environment,
 * which is why neither is in the repository: `pithy add secrets` writes the store id into
 * `~/.config/pithy`, and a CI runner has no such file unless the job exports it — which is precisely
 * the job `pithy deploy --kit` exists for.
 *
 * A resolver asks for one by calling `storeId()` / `accountId()`, so the hosts that skip are exactly
 * the hosts that bind it: email, media, storage, payments and secrets ask; support, testers and vector
 * hold no credential at all and deploy unaffected.
 */
const REQUIRED_VARS: Record<string, (capability: string) => string> = {
  SECRETS_STORE_ID: (capability) =>
    `SECRETS_STORE_ID is not set, so ${capability}'s Worker would deploy unable to read its master key. Run pithy add secrets on this machine, or export SECRETS_STORE_ID for this run.`,
  CLOUDFLARE_ACCOUNT_ID: (capability) =>
    `CLOUDFLARE_ACCOUNT_ID is not set, so ${capability}'s Worker would deploy naming no account to manage. Export CLOUDFLARE_ACCOUNT_ID for this run, or record it with pithy add secrets.`,
};

/** The default stamp reader: the account's Workers REST client, loaded only once a run needs it. */
async function workersVarsReader(credentials: { accountId: string; apiToken: string }): Promise<ReadWorkerVars> {
  const cf = await cloudflareClients(credentials);
  return (script) => cf.workers().getWorkerVars(script);
}

/**
 * The sentence a skip carries, from everything one resolution could not answer — or `undefined` when
 * it answered everything.
 *
 * One sentence per shortfall, in one row, because they are one fact about this environment and an
 * operator reading rows wants the whole of it. Names are sorted and de-duplicated throughout: the
 * order a resolver happens to ask its bindings in is an implementation detail, and a sentence that
 * reorders itself between releases is one nobody can grep a log for.
 */
function readinessReason(input: {
  missingIds: readonly { kind: "database" | "namespace"; binding: string }[];
  missingVars: readonly string[];
  capability: string;
  env: string;
  provision: string;
}): string | undefined {
  const reasons: string[] = [];
  const named = (kind: "database" | "namespace"): string[] =>
    [...new Set(input.missingIds.filter((one) => one.kind === kind).map((one) => one.binding))].sort();
  const clauses = (["database", "namespace"] as const)
    .map((kind) => ({ kind, bindings: named(kind) }))
    .filter((one) => one.bindings.length > 0)
    .map((one) => `${one.bindings.join(", ")} ${one.kind}`);
  if (clauses.length > 0) reasons.push(`${input.env} has no ${clauses.join(" and no ")} yet. ${input.provision}`);
  for (const name of [...new Set(input.missingVars)].sort()) {
    reasons.push(REQUIRED_VARS[name]?.(input.capability) ?? `${name} is not set.`);
  }
  return reasons.length > 0 ? reasons.join(" ") : undefined;
}

/** One capability's row: resolve, gate, deploy — or say which of those it could not get past. */
async function deployOneKitWorker(input: {
  host: HostWorker;
  /** The app Worker whose composition brought this host into the set — its address is the base URL. */
  source: WorkerTarget | undefined;
  options: DeployKitOptions;
  readTemplate: (projectDir: string, entry: string) => Promise<WorkflowHostTemplate>;
  readVars: ReadWorkerVars | undefined;
  databaseIds: Record<string, string>;
  kvNamespaceIds: Record<string, string>;
  stanza: KitStanza | undefined;
  storeId: string | undefined;
  accountId: string | undefined;
  credentials: { accountId: string; apiToken: string } | undefined;
}): Promise<KitWorkerDeploy> {
  const { host, options } = input;
  const capability = host.capability;
  const provision = `Run pithy ${capability} provision --env ${options.env}.`;

  if (!input.source) return skipped(capability, `No Worker in apps/ composes ${capability} any more.`);
  const baseUrl = await baseUrlFor(input.source, options.env, input.stanza);
  if (baseUrl === null) {
    return skipped(
      capability,
      `${input.source.name} composes ${capability} and has no ${options.env} address, so the links it sends would go nowhere. Declare domains.${options.env} in its pithy.config.ts.`,
    );
  }

  // **Every id the resolver asks for must already be one, and asking is how it declares the need.**
  // It asks for exactly the bindings the capability declares as `requiredBindings` on the app Worker,
  // so a hole is provisioning that has not run for this environment — a skip naming the command, never
  // a Worker deployed against a database, a namespace or a Secrets Store that does not exist.
  //
  // The four accessors below are the whole readiness check, and it is deliberately *not* a list of
  // things this file knows each capability needs: a tenth host asking for an eleventh id is covered by
  // the accessor it calls. Before #537 only `databaseId` recorded anything, so the store id and the
  // account id passed through empty and the row printed `deployed`.
  const missingIds: { kind: "database" | "namespace"; binding: string }[] = [];
  const missingVars: string[] = [];
  const required = (kind: "database" | "namespace", ids: Record<string, string>, binding: string): string => {
    const id = ids[binding];
    if (id === undefined) {
      missingIds.push({ kind, binding });
      return "";
    }
    return id;
  };
  const requiredVar = (name: string, value: string | undefined): string => {
    if (!isId(value)) {
      missingVars.push(name);
      return "";
    }
    return value as string;
  };

  let config: WorkflowHostTemplate;
  try {
    const template = await input.readTemplate(options.projectDir, host.spec.entry);
    config = await host.spec.resolve(template, {
      projectDir: options.projectDir,
      project: options.project,
      env: options.env,
      baseUrl,
      databaseId: (binding) => required("database", input.databaseIds, binding),
      kvNamespaceId: (binding) => required("namespace", input.kvNamespaceIds, binding),
      storeId: () => requiredVar("SECRETS_STORE_ID", input.storeId),
      accountId: () => requiredVar("CLOUDFLARE_ACCOUNT_ID", input.accountId),
      // **The adopter's own composed capability, which is the entire point of reading `apps/`.**
      // `discoverHostWorkers` already loaded each Worker's `pithy.config.ts` to decide the host set, so
      // the configured object is right here — and passing it is what makes `pithy deploy --kit` ship
      // the same config `pithy <capability> provision` does rather than schema defaults (#537).
      capability: host.composed,
      siblings: host.siblings,
    });
  } catch (error) {
    return { capability, worker: null, outcome: "failed", reason: failureReason(error) };
  }
  const shortfall = readinessReason({ missingIds, missingVars, capability, env: options.env, provision });
  if (shortfall) return skipped(capability, shortfall);

  try {
    const outcome = await deployHostWorker({
      capability,
      pkg: host.spec.package,
      version: await kitPackageVersion(options.projectDir, host.spec.package),
      config,
      dir: dirname(hostTemplatePath(options.projectDir, host.spec.entry)),
      env: options.env,
      readVars: input.readVars,
      runDeploy: options.runDeploy,
      credentials: input.credentials,
      force: options.force,
    });
    return { capability, worker: outcome.worker, outcome: outcome.outcome, reason: outcome.reason };
  } catch (error) {
    return { capability, worker: config.name, outcome: "failed", reason: failureReason(error) };
  }
}

/** Whether this run should fail the command. */
export function kitDeployFailed(report: KitDeployReport): boolean {
  // A run that could not read the project cannot say what it should have shipped, which is worse than
  // a skip: a skip names a capability and the command that answers it.
  if (report.problems.length > 0) return true;
  if (report.workers.some((row) => row.outcome === "failed")) return true;
  // **A run that shipped nothing because nothing was ready is a failure, not a quiet success.** A CI
  // job whose kit half skipped every Worker has deployed no kit Worker at all, and the operator has
  // to learn that from the exit code rather than from reading rows nobody prints on a green build.
  return report.workers.length > 0 && report.workers.every((row) => row.outcome === "skipped");
}

/** One kit row's human summary line — brand voice, the reason always beside the outcome. */
export function summarizeKitDeploy(row: KitWorkerDeploy): string {
  const name = row.worker ?? row.capability;
  const line = `${name}: ${row.outcome}. ${row.reason}`;
  // Red for the one outcome that fails the command on its own. A skip is a fact about the project,
  // not a fault of this run, and coloring it as one would train an operator to ignore both.
  return row.outcome === "failed" ? red(line) : line;
}

/**
 * One problem's line. Red, because it fails the command — the same rule the `failed` row follows, and
 * the reason a problem is not a note: the two look alike and only one of them lets a build stay green.
 */
export function summarizeKitProblem(problem: string): string {
  return red(problem);
}
