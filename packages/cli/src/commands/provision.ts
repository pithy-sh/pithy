// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { isProvisionableSecret, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
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
import { projectCapabilities, type ResolvedWorker, resolveWorkers } from "../project/workerScope";
import { assertProvisionConfirmed, provisionConfirmPhrase } from "../provision/confirm";
import {
  type ProvisionedDecline,
  type ProvisionedResource,
  type ProvisionProgress,
  type ProvisionReport,
  type ProvisionWorker,
  provisionEnvironment,
} from "../provision/environment";
import { type ProvisionMode, requireProvisionMode } from "../provision/mode";
import { type PendingSecrets, pendingSecretLines, pendingSecrets } from "../provision/pendingSecrets";
import { formatProvisionPlan, manifestFaultLines, provisionPlan } from "../provision/plan";
import { AUDIT_DESTINATION_ENV, cloudflareProvisioners, type ResourceProvisioners } from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import { storeEntryRemedy } from "../provision/secretEntryRemedy";
import { cloudflareSecretsStore, type SecretsStore } from "../provision/store";
import { formatDone, formatJsonLine, formatStep, withErrorReporting } from "../terminal/output";

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

/**
 * One resource, as a line: what it is called, and whether this run made it or found it.
 *
 * One sentence, one writer. It is printed as the resource settles now (#515) and was printed in the
 * summary before; two copies of it would drift the first time one of them was reworded, and an operator
 * comparing a streamed line against a summary line would have no way to tell a rewording from a
 * different resource.
 */
function resourceLine(resource: ProvisionedResource): string {
  return `${resource.name}: ${resource.created ? "created" : "exists"}.`;
}

/**
 * **Where a run narrates itself, or nothing at all.**
 *
 * The gate is `--json` and only `--json`: every command is agent-drivable, and a machine reads exactly one
 * line. It is deliberately **not** the `interactive` boolean the confirm prompt uses — that one also asks
 * whether a TTY is attached, and a run in CI is the run whose log most needs to say where it got to. A
 * non-TTY simply renders these lines plain, which is what the whole terminal seam already does with color.
 */
export function provisionProgress(options: { json: boolean }): ProvisionProgress | undefined {
  if (options.json) return undefined;
  return (event) => {
    // `▸ <name>...` before the find, then the settled line the summary used to hold until the end.
    const line = event.phase === "start" ? formatStep(event.name) : resourceLine(event.resource);
    process.stdout.write(`${line}\n`);
  };
}

/**
 * One Worker resolution, read as many times as a run needs it.
 *
 * The plan and the work must name the same Workers, and the cheapest way to guarantee that is to resolve
 * them once and hand the same array to both. Memoized on the promise rather than the result, so two
 * callers racing it still share one read.
 */
function workerSetOnce(projectDir: string): () => Promise<ResolvedWorker[]> {
  let pending: Promise<ResolvedWorker[]> | null = null;
  return () => (pending ??= resolveWorkers({ projectDir }));
}

/** The provisioning view of a resolved Worker: where it lives, what it composes, what it declines. */
function provisionWorkers(workers: readonly ResolvedWorker[]): ProvisionWorker[] {
  return workers.map((worker) => ({
    name: worker.name,
    dir: worker.dir,
    capabilities: worker.capabilities,
    config: worker.config,
  }));
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
  options: {
    json: boolean;
    seeded: boolean;
    pending: PendingSecrets;
    /**
     * The project's merged secret registry — read for one fact and one only: a missing entry's declared
     * `scope`, which decides whether its `pithy secrets create` carries `--env` (#517).
     *
     * `ProvisionedSecret` does not carry the scope and this report cannot invent it: `secretWriteTargets`
     * refuses `--env` on a `global` secret, so a remedy that guessed would be the third round of this
     * issue printed by a different command. The registry is the authority both reports read, which is
     * what makes them able to agree.
     */
    registry: SecretRegistry;
    /**
     * Whether each resource already printed its own line as it settled (#515).
     *
     * The summary's resource block **moves** rather than being joined by a second copy: with the lines
     * arriving in place, interleaved with the `▸` step that produced each one, repeating them at the end
     * says nothing the scrollback above does not already say in better order. Everything else in the
     * summary stays — those are facts about the run as a whole, not about one resource.
     *
     * Defaulted off, because `--json` streams nothing and neither does any caller that passes no sink.
     */
    streamed?: boolean;
  },
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
  if (!options.streamed) {
    for (const resource of report.resources) process.stdout.write(`${resourceLine(resource)}\n`);
  }
  // **First of the summary lines, because it is what puts the lines under it in doubt.** A capability
  // whose manifest would not parse still gets its resources created — the bindings come from the composed
  // instance — but under the generic `<project>-<env>-<binding>` name, because `scope` and `resource` are
  // read out of the file nobody could open (#513). A project-global database created per environment is
  // the exact split #513 removed, and without this line the run reporting it is byte-identical to a
  // healthy one (#184). To stderr, like `pithy add`'s and for the same reason: it is a defect in someone's
  // package rather than a fact about this run, and a `--json` consumer already has it as `manifestFaults`.
  for (const line of manifestFaultLines(report.manifestFaults)) process.stderr.write(`${line}\n`);
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
      // **`doctor`'s answer, not a second one** (#517). This is the same finding that command reports
      // from the files afterwards, and each report used to render it itself: a reviewer ran both to
      // completion and found doctor's corrected and this one still naming the dead end four rounds had
      // been about. Sharing the *renderer* was the first fix and was not enough — this went on handing
      // it the supplied-value question for every secret, including the mintable ones and the master key,
      // and told an operator to hand-write a value the next `pithy secrets provision` would generate. So
      // it asks `storeEntryRemedy`, which is the whole answer, over the registry facts doctor reads too:
      // the scope decides whether the command carries `--env`, and `isProvisionableSecret` decides which
      // of the two commands it is.
      const declared = options.registry[secret.binding];
      process.stdout.write(
        `${secret.binding} has no store entry yet. ${storeEntryRemedy([
          {
            binding: secret.binding,
            scope: declared?.scope ?? "environment",
            env: report.env,
            provisionable: declared !== undefined && isProvisionableSecret(secret.binding, declared),
          },
        ])}\n`,
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
  const project = requireProjectName(config);
  // The scope carries both the names and the stanza. There is no second argument to disagree with.
  const scope = environmentScope(project, environment);
  // Resolved once, read by the plan and by the run — so the two cannot name different Workers.
  const resolved = workerSetOnce(projectDir);
  const workers = async (): Promise<ProvisionWorker[]> => provisionWorkers(await resolved());
  const progress = provisionProgress(options);
  await assertProvisionConfirmed({
    env: environment,
    yes: options.yes,
    json: options.json,
    // The plan, before anyone agrees to it and before the first Cloudflare call (#515). Under `--json`
    // there is no sink, so nothing is resolved for it and nothing is printed.
    ...(progress
      ? {
          announce: async () => {
            const plan = await provisionPlan({
              projectDir,
              project,
              scope,
              capabilities: projectCapabilities(await resolved()),
              workers: await workers(),
            });
            process.stdout.write(`${formatProvisionPlan(plan)}\n\n`);
          },
        }
      : {}),
    ...(options.confirm !== undefined ? { confirmPhrase: options.confirm } : {}),
    ...(interactive ? { prompt: confirmPrompt(environment) } : {}),
    ...(config.seed?.productionEnvironments !== undefined
      ? { productionEnvironments: config.seed.productionEnvironments }
      : {}),
  });

  const account = loadProjectCloudflare(config) ?? null;
  const provisioners = await requireProvisioners(account, environment);
  const capabilities = projectCapabilities(await resolved());
  const store = await buildStore(account);
  const audit = await buildAudit(projectDir, capabilities, account);
  const report = await provisionEnvironment({
    projectDir,
    scope,
    capabilities,
    provisioners,
    // The Workers the plan named, not a second resolution that might disagree with it.
    resolveWorkers: workers,
    ...(progress ? { onProgress: progress } : {}),
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
  writeReport(report, {
    json: options.json,
    seeded: options.seed,
    pending: deferredSecrets(capabilities, mode),
    registry: workerSecretRegistry(capabilities) ?? {},
    streamed: progress !== undefined,
  });
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
  const scope = featureScope(identity);
  const resolved = workerSetOnce(projectDir);
  const workers = async (): Promise<ProvisionWorker[]> => provisionWorkers(await resolved());
  const progress = provisionProgress(options);
  // No confirmation gate here — a feature environment is created per pull request, so there is no prompt
  // to hang the plan off. It goes where the confirmation's would: before the first Cloudflare call.
  if (progress) {
    const plan = await provisionPlan({
      projectDir,
      project: identity.project,
      scope,
      capabilities,
      workers: await workers(),
    });
    process.stdout.write(`${formatProvisionPlan(plan)}\n\n`);
  }
  const account = await projectCloudflareAccount(projectDir);
  const provisioners = await requireProvisioners(account, "a feature environment");
  const store = await buildStore(account);
  const report = await provisionFeature({
    projectDir,
    capabilities,
    ...(store ? { store } : {}),
    identity,
    provisioners,
    resolveWorkers: workers,
    ...(progress ? { onProgress: progress } : {}),
    audit: await buildAudit(projectDir, capabilities, account),
  });
  writeReport(report, {
    json: options.json,
    seeded: true,
    pending: deferredSecrets(capabilities, mode),
    registry: workerSecretRegistry(capabilities) ?? {},
    streamed: progress !== undefined,
  });
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
