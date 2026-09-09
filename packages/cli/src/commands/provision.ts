// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { defineCommand } from "citty";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { storeSecretMinter } from "../capabilities/mintSecrets";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
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
import { type ProvisionedDecline, type ProvisionReport, provisionEnvironment } from "../provision/environment";
import { type ProvisionMode, requireProvisionMode } from "../provision/mode";
import { type PendingSecrets, pendingSecretLines, pendingSecrets } from "../provision/pendingSecrets";
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
async function buildProvisioners(account: CloudflareAccountSelection | null): Promise<ResourceProvisioners | null> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  // What vouches for that id travels with it (#378). `find` is find-or-create's first half, and an empty
  // listing from an account nothing claims is not the absence the second half reads it as.
  const confirmation = cloudflareAccountConfirmation({ account });
  return cloudflareProvisioners(await cloudflareClients({ accountId, apiToken }), { accountId, confirmation });
}

/**
 * The account's Secrets Store, or `null` when this project has recorded no store id.
 *
 * Absent is a degraded environment, never a failed command: a project composing no `secrets` capability
 * needs no store, and one that does gets its `secrets_store_secrets` stanza — the binding `pithy add`
 * deliberately could not write, and nothing came back for (#238).
 */
async function buildStore(account: CloudflareAccountSelection | null): Promise<SecretsStore | null> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  const storeId = vars.SECRETS_STORE_ID ?? "";
  if (!accountId || !apiToken || !storeId) return null;
  return cloudflareSecretsStore(await cloudflareClients({ accountId, apiToken }), storeId);
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
    clients: await cloudflareClients({ accountId, apiToken }),
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
async function requireProvisioners(
  account: CloudflareAccountSelection | null,
  target: string,
): Promise<ResourceProvisioners> {
  const provisioners = await buildProvisioners(account);
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
 * **What this command declares and cannot create**, and who can — which is not the same answer in both
 * modes. See `provision/pendingSecrets.ts`, which holds the reasoning and the sentences.
 */
function deferredSecrets(capabilities: Capability[], mode: ProvisionMode): PendingSecrets {
  return pendingSecrets(workerSecretRegistry(capabilities) ?? {}, mode);
}

/**
 * **What this run left out, and why — one line per Worker's declaration.**
 *
 * A decline is the one input that removes work, and until #514 the run said nothing about it: the summary
 * lists what was made, so a decline honored and a decline dropped on the floor printed the same output.
 * The reason string is mandatory in `declinedBindings` precisely so a report can hand it back, so it goes
 * out verbatim — it is the adopter's own sentence, and rewording it would lose the one fact the line has
 * that the binding name does not.
 *
 * One sentence per outcome, because reading any two of them as one is a lie an operator acts on:
 *
 * - **Declined, and nothing created for it** — the ordinary case. **"by this run"**, and the words are
 *   load-bearing: adding a decline to an environment that was already provisioned is the *likeliest* way
 *   to reach this line, and there the bucket is in the account and the Worker's stanza still binds it,
 *   because provisioning upserts and never deletes (`applyProvisionedEnv`, and docs/CLI.md says so on
 *   purpose). A bare "Not created." claims a fact about an account this run did not check, and the
 *   operator concludes the decline took effect while the Worker still deploys against the resource.
 * - **Declined and created anyway** — a sibling Worker declares the same binding name and wants it, which
 *   is how two Workers share a database. This Worker's stanza leaves it out; the resource is there.
 * - **Declined and refused, or naming nothing** — a `required` or `undeclinable` binding, or a name no
 *   composed capability declares. Nothing was left out, and the run says so rather than printing the
 *   silence a project that declines nothing prints. The likeliest typo in a decline is in the binding
 *   name, and that one lands here.
 * - **Unreadable** — one typo in the block and every declined resource is created. That state collapses
 *   to an empty set at the filter, so without this line the run is indistinguishable from a project that
 *   declines nothing, which is the failure the whole declaration exists to prevent.
 */
function describeDeclines(report: ProvisionReport): string[] {
  return report.declined.flatMap((entry) => {
    if (entry.state === "invalid") {
      return [
        `declinedBindings in ${entry.worker}'s pithy.config.ts cannot be read, so nothing was left out: ${entry.problem}`,
      ];
    }
    return entry.declines.map((decline) => `${declineFate(decline, entry.worker)} — ${decline.reason}`);
  });
}

/**
 * The half of a decline line before the adopter's own sentence: what it is, and what became of it.
 *
 * The kind rides with the name wherever there is one, so the lines stack in a column an operator can
 * skim. `unrecognized` is the one state with no kind to name, because it resolved against no binding.
 */
function declineFate(decline: ProvisionedDecline, worker: string): string {
  const named = decline.state === "unrecognized" ? decline.name : `${decline.name} (${decline.type})`;
  const declined = `${named} declined by ${worker}.`;
  switch (decline.state) {
    case "honored":
      return decline.wantedBy.length === 0
        ? `${declined} Not created by this run.`
        : `${declined} Created anyway for ${decline.wantedBy.join(", ")}.`;
    case "required":
      return `${declined} ${decline.capability} requires it, so nothing was left out.`;
    case "undeclinable":
      return `${declined} Its kind cannot be declined, so nothing was left out.`;
    default:
      return `${declined} Nothing it composes declares it, so nothing was left out.`;
  }
}

/**
 * Write the report: one JSON line, or the human summary.
 *
 * Exported for its tests. It is the whole of what an operator sees of a run that created nothing, and a
 * command whose output is only reachable by provisioning against a live account is a command whose output
 * nothing checks.
 */
export function writeReport(
  report: ProvisionReport,
  options: { json: boolean; seeded: boolean; pending: PendingSecrets },
): void {
  if (options.json) {
    process.stdout.write(
      `${formatJsonLine({
        command: "provision",
        ...report,
        pendingSecrets: options.pending.names,
        pendingSecretsRemedy: options.pending.remedy,
      })}\n`,
    );
    return;
  }
  for (const resource of report.resources) {
    process.stdout.write(`${resource.name}: ${resource.created ? "created" : "exists"}.\n`);
  }
  // Beside what was made, because it is the same subject: what this environment has, and what it does not.
  for (const line of describeDeclines(report)) process.stdout.write(`${line}\n`);
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
  for (const line of pendingSecretLines(options.pending)) process.stdout.write(`${line}\n`);
  process.stdout.write(`${formatDone()}\n`);
}

/**
 * `--env <name>`: an environment the project declares, whose ids are source.
 *
 * It takes the resolved {@link ProvisionMode} rather than a bare name, and hands it on to the deferred-
 * secrets report. There is one producer of the mode — `requireProvisionMode`, in `runProvision` — so
 * neither branch can report itself as the other, which is how `--feature` came to print `--env`'s
 * remedy in the first place (#330).
 */
async function provisionDeclared(
  projectDir: string,
  mode: Extract<ProvisionMode, { kind: "environment" }>,
  options: ProvisionRunOptions,
): Promise<void> {
  const env = mode.env;
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
  const provisioners = await requireProvisioners(account, environment);
  const capabilities = projectCapabilities(await resolveWorkers({ projectDir }));
  // The scope carries both the names and the stanza. There is no second argument to disagree with.
  const scope = environmentScope(requireProjectName(config), environment);
  const store = await buildStore(account);
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
  writeReport(report, { json: options.json, seeded: options.seed, pending: deferredSecrets(capabilities, mode) });
}

/**
 * `--feature`: this branch's own environment, whose ids are a build artifact.
 *
 * **No confirmation gate, and that is not an omission.** A feature environment is created per pull
 * request and destroyed on merge; requiring the phrase that protects production would put it in every
 * pipeline, which is exactly how a gate stops meaning anything. It also always seeds — a feature
 * environment is created empty and useless without fixtures — so `--seed` has nothing to add to it.
 */
async function provisionBranch(
  projectDir: string,
  mode: Extract<ProvisionMode, { kind: "feature" }>,
  options: ProvisionRunOptions,
): Promise<void> {
  const { identity, capabilities } = await branchIdentity(projectDir);
  const account = await projectCloudflareAccount(projectDir);
  const provisioners = await requireProvisioners(account, "a feature environment");
  const store = await buildStore(account);
  const report = await provisionFeature({
    projectDir,
    capabilities,
    ...(store ? { store } : {}),
    identity,
    provisioners,
    audit: await buildAudit(projectDir, capabilities, account),
  });
  writeReport(report, { json: options.json, seeded: true, pending: deferredSecrets(capabilities, mode) });
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
  if (mode.kind === "feature") return provisionBranch(projectDir, mode, options);
  return provisionDeclared(projectDir, mode, options);
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
