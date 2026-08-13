// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { defineCommand } from "citty";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { managerMintedSecrets, storeSecretMinter } from "../capabilities/mintSecrets";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { branchIdentity } from "../feature/identity";
import { provisionFeature } from "../feature/provision";
import {
  loadProject,
  loadProjectCloudflare,
  loadProjectEnvironments,
  projectCloudflareAccount,
  requireProjectName,
} from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { assertProvisionConfirmed, provisionConfirmPhrase } from "../provision/confirm";
import { type ProvisionReport, provisionEnvironment } from "../provision/environment";
import { requireProvisionMode } from "../provision/mode";
import { AUDIT_DESTINATION_ENV, cloudflareProvisioners, type ResourceProvisioners } from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import { cloudflareSecretsStore, type SecretsStore } from "../provision/store";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy provision --env <name>` and `pithy provision --feature` — **one command, because provisioning is
 * one job.**
 *
 * Both create an environment's Cloudflare resources, write their ids into each Worker's config, and
 * migrate. They differ only in how the target environment is *named*: declared in the root
 * `pithy.config.ts`, or derived from the checked-out branch. That is a flag, not a different verb.
 *
 * **The safety is in the scope, not in the spelling.** A `ProvisionScope` carries the resource naming and
 * the `env.<name>` stanza the ids are written into, as one value (#240) — so a feature-named resource
 * landing in a declared environment's stanza of a checked-in config is unexpressible rather than merely
 * refused. Nothing about that depends on which words were typed, which is what leaves one command free to
 * carry both modes.
 *
 * **The one real difference is persistence, and the command says so on every run.** `--env` writes
 * `env.<name>` into the tracked `wrangler.jsonc`: long-lived ids a human reviews in a pull request.
 * `--feature` writes a generated config under the already-ignored `.wrangler/`: one job's output,
 * rebuilt every run and never committed. A single flag that flips whether output is committed will
 * eventually surprise someone, so each run names the file it wrote and whether that file is committed,
 * in the human summary and as `--json`'s `committed`. It is also what keeps the standing rule checkable
 * rather than remembered — **a CI build process never commits back to the repository**: a pipeline runs
 * `--feature` and has nothing to commit.
 *
 * **It is still its own command, and `deploy` refuses rather than calling it.** A deploy that silently
 * creates account resources is hard to review. `pithy deploy --env staging` names this command instead of
 * failing inside wrangler.
 *
 * **There is no `pithy deprovision`.** `pithy feature destroy` reverses a branch's environment because a
 * branch's environment is disposable. Staging and production are not, and the one-word difference between
 * the two is not a difference a flag should carry.
 */

/** Build the CF control-plane provisioners from the environment's credentials, or null when they are absent. */
function buildProvisioners(account: CloudflareAccountSelection | null): ResourceProvisioners | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  return cloudflareProvisioners(new CloudflareClients({ accountId, apiToken }));
}

/**
 * The account's Secrets Store, or `null` when this project has recorded no store id.
 *
 * Absent is a degraded environment, never a failed command: a project composing no `secrets` capability
 * needs no store, and one that does gets its `secrets_store_secrets` stanza — the binding `pithy add`
 * deliberately could not write, and nothing came back for (#238).
 */
function buildStore(account: CloudflareAccountSelection | null): SecretsStore | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken || !storeId) return null;
  return cloudflareSecretsStore(new CloudflareClients({ accountId, apiToken }), storeId);
}

/**
 * The audit emitter. Provisioning creates real infrastructure under a real token, and it runs headlessly
 * in CI, so every creation leaves a record of what was made and under whose credentials.
 *
 * The trail lands in the project's own top-level database — the environment being provisioned may not
 * have one yet, which is the whole point of the command.
 */
async function buildAudit(
  projectDir: string,
  capabilities: Capability[],
  account: CloudflareAccountSelection | null,
): Promise<CliAuditEmit> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  return createCliAudit({
    projectDir,
    // Routing, not truth: each event names the environment it acted on. Claiming this as `actedOn`
    // would blame `dev` for a change to production — the regression `auditDestination.test.ts` pins.
    env: AUDIT_DESTINATION_ENV,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** The interactive confirm prompt for a production environment. Names what is about to happen first. */
function confirmPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This creates Cloudflare resources in ${env}. Type "${provisionConfirmPhrase(env)}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

/** Refuse a run with no credentials, naming the environment it was for. */
function requireProvisioners(account: CloudflareAccountSelection | null, target: string): ResourceProvisioners {
  const provisioners = buildProvisioners(account);
  if (provisioners) return provisioners;
  throw new ValidationError({
    message: "Cloudflare credentials are missing.",
    action: `Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to provision ${target}.`,
  });
}

/** Everything `pithy provision` reads off the command line. */
export interface ProvisionRunOptions {
  /**
   * The project root. Defaults to the working directory.
   *
   * A seam, and one the refusal gate needs: `commands/provision.test.ts` proves the mode is refused
   * before anything is read by pointing this at a directory that is not a project at all, which a test
   * that had to `chdir` could not do without racing every other suite in the pool.
   */
  projectDir?: string;
  /** `--env <name>`: a declared environment. */
  env?: string | undefined;
  /** `--feature`: this branch's own environment. */
  feature: boolean;
  /** `--yes`. Required for a declared environment; never sufficient for production. */
  yes: boolean;
  /** `--confirm <phrase>`: the production phrase, for a headless run. */
  confirm?: string | undefined;
  /** `--seed`: also load fixtures. A feature environment is always seeded, so this adds nothing to it. */
  seed: boolean;
  /** `--json`. */
  json: boolean;
}

/** One line per file written: what landed there, and what happens to it next. */
function describeConfigs(report: ProvisionReport): string[] {
  return report.configs.map((config) => {
    const what = config.ids === 0 ? config.path : `${config.ids} id${config.ids === 1 ? "" : "s"} into ${config.path}`;
    // The whole point of the line: one flag decides whether these bytes are reviewed and kept, or thrown
    // away and rebuilt. Saying which costs a sentence and saves someone committing a build artifact — or
    // wondering why an id they were told to commit is not in `git status`.
    const fate = report.committed
      ? `Commit ${config.ids > 1 ? "them" : "it"}.`
      : "Ignored, and rebuilt on the next run.";
    return `Wrote ${what}. ${fate}`;
  });
}

/**
 * **What this command declares and cannot create.**
 *
 * A `d1` secret's value is sealed under a master key that lives inside the environment's manager
 * Worker, so only that manager can say whether one exists — and `pithy provision` runs *before* the
 * managers are necessarily deployed. It therefore creates none of them, which is a real limit and not a
 * bug to be papered over.
 *
 * The bug was that it finished quietly anyway. A run that says `Provisioned prod. Migrated.` while the
 * session signing key and the link signing key are absent has reported success for an environment that
 * cannot serve a request, and the next person to find out is a user. So the run names them, and names
 * the one command that does make them.
 */
function pendingSecrets(capabilities: Capability[]): string[] {
  const registry = workerSecretRegistry(capabilities);
  return registry ? managerMintedSecrets(registry) : [];
}

/** Write the report: one JSON line, or the human summary. */
function writeReport(
  report: ProvisionReport,
  options: { json: boolean; seeded: boolean; pending: readonly string[] },
): void {
  if (options.json) {
    process.stdout.write(`${formatJsonLine({ command: "provision", ...report, pendingSecrets: options.pending })}\n`);
    return;
  }
  for (const resource of report.resources) {
    process.stdout.write(`${resource.name}: ${resource.created ? "created" : "exists"}.\n`);
  }
  for (const worker of report.workers) {
    process.stdout.write(`${worker.worker} deploys as ${worker.name}.\n`);
  }
  for (const service of report.services) {
    process.stdout.write(`${service.binding} bound to ${service.service}.\n`);
  }
  for (const secret of report.secretBindings) {
    // Three states, and the middle one is new (#321): created by this run, already there, or waiting on
    // a human. The value never appears — what was made and where it went is the whole useful report.
    if (secret.minted) {
      process.stdout.write(`${secret.binding} created. Reads ${secret.entry}.\n`);
    } else if (secret.bound) {
      process.stdout.write(`${secret.binding} reads ${secret.entry}.\n`);
    } else {
      process.stdout.write(
        `${secret.binding} has no store entry yet. Create it with pithy secrets create ${secret.binding}.\n`,
      );
    }
  }
  for (const line of describeConfigs(report)) process.stdout.write(`${line}\n`);
  process.stdout.write(`Provisioned ${report.env}. ${options.seeded ? "Migrated and seeded." : "Migrated."}\n`);
  // Before `Done.`, because it is the part of the job this command did not do. See `pendingSecrets`.
  if (options.pending.length > 0) {
    process.stdout.write(`${options.pending.join(", ")}: not created here — they need a deployed manager.\n`);
    process.stdout.write("Run pithy secrets provision to create them.\n");
  }
  process.stdout.write(`${formatDone()}\n`);
}

/** `--env <name>`: an environment the project declares, whose ids are source. */
async function provisionDeclared(projectDir: string, env: string, options: ProvisionRunOptions): Promise<void> {
  const config = await loadProject(projectDir);
  // The declaration decides what may be provisioned. `--env live` on a project that never declared
  // `live` is refused here, naming the set it does have — rather than creating `<project>-live-db`
  // that nothing else in the CLI would ever look for again. It is also what closes `--env feature`:
  // that name is a legal stanza key and an illegal declaration, so no project can admit it.
  const environment = requireManagedEnvironment(env, loadProjectEnvironments(config));
  const interactive = !options.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  await assertProvisionConfirmed({
    env: environment,
    yes: options.yes,
    json: options.json,
    ...(options.confirm !== undefined ? { confirmPhrase: options.confirm } : {}),
    ...(interactive ? { prompt: confirmPrompt(environment) } : {}),
    ...(config.seed?.productionEnvironments !== undefined
      ? { productionEnvironments: config.seed.productionEnvironments }
      : {}),
  });

  const account = loadProjectCloudflare(config) ?? null;
  const provisioners = requireProvisioners(account, environment);
  const capabilities = projectCapabilities(await resolveWorkers({ projectDir }));
  // The scope carries both the names and the stanza. There is no second argument to disagree with.
  const scope = environmentScope(requireProjectName(config), environment);
  const store = buildStore(account);
  const audit = await buildAudit(projectDir, capabilities, account);
  const report = await provisionEnvironment({
    projectDir,
    scope,
    capabilities,
    provisioners,
    ...(store
      ? {
          secretBindings: async (workerCapabilities) =>
            secretsStoreBindings({
              // A Worker composing no secrets capability declares no secrets, and gets no stanza.
              registry: workerSecretRegistry(workerCapabilities) ?? {},
              scope,
              storeId: store.storeId,
              exists: (name) => store.exists(name),
              // A declared secret whose value is arbitrary is created here rather than printed as
              // homework (#321). Absence is checked first, so an existing value is never replaced.
              mint: storeSecretMinter({ store, environment: scope.stanza, audit }),
            }),
        }
      : {}),
    // Off unless asked. A declared environment already holds real rows; seeding one is `pithy seed`'s
    // job, with its own gate, and it must not be something provisioning did on the way past.
    seedData: options.seed,
    audit,
  });
  writeReport(report, { json: options.json, seeded: options.seed, pending: pendingSecrets(capabilities) });
}

/**
 * `--feature`: this branch's own environment, whose ids are a build artifact.
 *
 * **No confirmation gate, and that is not an omission.** A feature environment is created per pull
 * request and destroyed on merge; requiring the phrase that protects production would put it in every
 * pipeline, which is exactly how a gate stops meaning anything. It also always seeds — a feature
 * environment is created empty and useless without fixtures — so `--seed` has nothing to add to it.
 */
async function provisionBranch(projectDir: string, options: ProvisionRunOptions): Promise<void> {
  const { identity, capabilities } = await branchIdentity(projectDir);
  const account = await projectCloudflareAccount(projectDir);
  const provisioners = requireProvisioners(account, "a feature environment");
  const store = buildStore(account);
  const report = await provisionFeature({
    projectDir,
    capabilities,
    ...(store ? { store } : {}),
    identity,
    provisioners,
    audit: await buildAudit(projectDir, capabilities, account),
  });
  writeReport(report, { json: options.json, seeded: true, pending: pendingSecrets(capabilities) });
}

/**
 * The command body, exported so the mode gate can be tested against a directory that is not a project.
 *
 * Throws `PithyError`; the citty wrapper below is what reports and exits.
 */
export async function runProvision(options: ProvisionRunOptions): Promise<void> {
  // First, before the working directory is read, before a config is loaded, and before any Cloudflare
  // client exists. A run that named no environment or two is a mistake in the command line, and it gets
  // an answer about the command line.
  const mode = requireProvisionMode(options);
  const projectDir = options.projectDir ?? process.cwd();
  if (mode.kind === "feature") return provisionBranch(projectDir, options);
  return provisionDeclared(projectDir, mode.env, options);
}

export default defineCommand({
  meta: {
    name: "provision",
    description: "Create an environment's own Cloudflare resources, wire them into each Worker, then migrate",
  },
  args: {
    env: { type: "string", description: "The declared environment to provision" },
    feature: { type: "boolean", default: false, description: "Provision this branch's own environment instead" },
    yes: { type: "boolean", default: false, description: "Confirm that this creates real Cloudflare resources" },
    confirm: {
      type: "string",
      description: 'Unlock a production environment non-interactively: "yes, i really want to provision <env>"',
    },
    seed: { type: "boolean", default: false, description: "With --env: also load seed fixtures once the schema is up" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, () =>
      runProvision({
        env: args.env,
        feature: args.feature,
        yes: args.yes,
        confirm: args.confirm,
        seed: args.seed,
        json: args.json,
      }),
    ),
});
