// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { canonicalIssue } from "@pithy-sh/core/src/naming/feature";
import { MAX_ISSUE_DIGITS } from "@pithy-sh/core/src/naming/limits";
import { defineCommand } from "citty";
import { z } from "zod";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { cloudflareFeatureIndexes } from "../capabilities/vectorProvisioner";
import { cloudflareClients, cloudflareWorkflows } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { withContract } from "../contract/commandContract";
import { createFeature } from "../feature/create";
import { type DestroyReport, destroyedBeforeFailure, destroyFeature, type RemoteTeardown } from "../feature/destroy";
import { DevConfig } from "../feature/devConfig";
import { branchIdentityWithoutWorkers, deriveIdentityFromBranch, featureWorkerSet } from "../feature/identity";
import { isolatedCheckNotice } from "../feature/isolatedCheck";
import { PortBlock, portsRegistryPath } from "../feature/ports";
import { OrphanedBlock, pruneFeatureBlocks, prunePlan } from "../feature/prune";
import { assertFeatureSlugFitsProject } from "../feature/slugBudget";
import { syncFeatureDevConfig } from "../feature/sync";
import { behindRemote, featureWorktree, mainRepoRoot } from "../feature/worktree";
import { DRY_RUN_ARG, PlanKey } from "../plan/plan";
import { loadProject, loadProjectCloudflare, projectCloudflareAccount } from "../project/config";
import { requireEnvironment } from "../project/environment";
import { detectPackageManager } from "../project/packageManager";
import { type CapabilitySet, capabilitySetOf, isUnknown } from "../project/workerScope";
import {
  AUDIT_DESTINATION_ENV,
  cloudflareFeatureRepos,
  cloudflareProvisioners,
  cloudflareWorkerScripts,
  cloudflareWorkflowDefinitions,
} from "../provision/resources";
import { cloudflareSecretsStore, type SecretsStore } from "../provision/store";
import { externalLines, setupLines } from "../setup/render";
import { isBlockedPlan, setupCheckout } from "../setup/run";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * The feature's own ephemeral CF environment.
 *
 * `destroy` takes an `--env` because it names the environment its audit trail records; it deletes by
 * recomputed feature name regardless, so the flag never changes what goes. Standing the environment up is
 * `pithy provision --feature`'s job — one job with two spellings, and this is not one of them.
 */
const DEFAULT_FEATURE_ENV = FEATURE_ENVIRONMENT;

/**
 * Build the account seams teardown deletes through — the resource provisioners and the Worker scripts —
 * from the environment's credentials, or null when they are absent.
 *
 * One builder for both, over one set of clients and one confirmed account, so the two halves of a
 * teardown cannot be addressed to two different accounts, and neither can be built without the other.
 */
async function buildTeardown(
  account: CloudflareAccountSelection | null,
  projectDir: string,
  project: string,
): Promise<Required<RemoteTeardown> | null> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  // What vouches for that id travels with it. `find` is find-or-create's first half, and an empty
  // listing from an account nothing claims is not the absence the second half reads it as.
  const confirmed = { accountId, confirmation: cloudflareAccountConfirmation({ account }) };
  const clients = await cloudflareClients({ accountId, apiToken });
  const provisioners = cloudflareProvisioners(clients, confirmed);
  return {
    provisioners,
    scripts: cloudflareWorkerScripts(clients, confirmed),
    // Every kit host's Workflows, deleted by name. No token: a feature's manager holds none.
    workflows: cloudflareWorkflowDefinitions(await cloudflareWorkflows({ accountId, apiToken })),
    indexes: cloudflareFeatureIndexes({
      projectDir,
      cf: clients,
      accountId,
      apiToken,
      project,
      workflows: await cloudflareWorkflows({ accountId, apiToken }),
    }),
    // Every repo in the feature's own Artifacts namespace, where the feature binds one.
    repos: cloudflareFeatureRepos(clients),
  };
}

/**
 * The account's Secrets Store, or `null` when this project has not recorded one.
 *
 * **Absent is a degraded feature environment, never a failed command.** A project that composes no
 * `secrets` capability has no store id and needs none; one that does gets its own master key and its
 * `secrets_store_secrets` bindings. Either way the rest of the feature stands up, and the report says
 * which happened.
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
 * The audit emitter for a feature command, or a no-op when auditing is unavailable. Feature provisioning
 * and teardown change real infrastructure — and `destroy` runs headlessly in CI — so every create and
 * delete leaves a record of what happened under which token. Credentials are the same ones the command
 * already needs; without them there is nothing to record through and the emitter is inert.
 *
 * These are control-plane operations: they touch real Cloudflare whatever environment is named, so they use
 * `createCliAudit` directly rather than the remote-gated variant, and are always recorded.
 */
async function buildAudit(
  projectDir: string,
  capabilities: CapabilitySet,
  account: CloudflareAccountSelection | null,
): Promise<CliAuditEmit> {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  return createCliAudit({
    projectDir,
    env: AUDIT_DESTINATION_ENV,
    capabilities,
    clients: await cloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/**
 * The seams `feature destroy`'s remote half deletes through, resolved against the project's account: the
 * teardown, the store, and the account the audit is built for.
 *
 * Refuses on an account mismatch, through the guard each builder resolves with, and refuses when the
 * credentials are missing. Called only when the remote half will run, so `--local-only` reaches neither
 * refusal.
 */
async function remoteHalf(
  projectDir: string,
  configDir: string,
  project: string,
): Promise<{
  teardown: Required<RemoteTeardown>;
  store: SecretsStore | null;
  account: CloudflareAccountSelection | null;
}> {
  const account = await projectCloudflareAccount(projectDir);
  // The feature's own indexes are composed from the feature's own configs, as its capability set is.
  const teardown = await buildTeardown(account, configDir, project);

  // Without credentials the remote half cannot run. Skipping it silently is the worst outcome: every
  // Worker script and D1/KV/R2 leaks while the run reports success, and teardown then deletes the
  // branch the names are derived from — so a later attempt can no longer work out what to delete. A CI
  // job whose credentials did not propagate must fail loudly. `--local-only` is the deliberate opt-out.
  if (!teardown) {
    throw new PreconditionFailedError({
      message: "Cloudflare credentials are missing, so the feature's resources cannot be deleted.",
      action:
        `Run ${commandName("cloudflare connect")}, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, to tear down the remote environment, ` +
        "or pass --local-only to remove just the worktree and its ports.",
    });
  }
  return { teardown, store: await buildStore(account), account };
}

/** `pithy feature create <slug> --issue <n>` — local, automatic. Run from the main checkout. */
const Branch = z.string().describe("The feature branch.");

/** `pithy feature create --json`. `docs/commands/feature.md`. */
const FeatureCreatePayload = z
  .object({
    command: z.literal("feature.create").describe('`"feature.create"`.'),
    branch: Branch,
    worktree: z.string().describe("The absolute worktree path."),
    worktreeCreated: z.boolean().describe("Whether a new worktree was created. `false` on a re-run over one."),
    base: z
      .string()
      .nullable()
      .describe("The ref the branch was cut from, or `null` when nothing was cut — an existing worktree or branch."),
    dev: DevConfig,
    behindRemote: z
      .number()
      .int()
      .nullable()
      .describe("How many commits the base is behind its remote, or `null` when level, remote-less or not cut."),
  })
  .describe("What `pithy feature create` set up.");

/** `pithy feature sync --json`. */
const FeatureSyncPayload = z
  .object({
    command: z.literal("feature.sync").describe('`"feature.sync"`.'),
    branch: Branch,
    block: PortBlock,
    dev: DevConfig,
    addedWorkers: z.array(z.string().describe("A Worker.")).describe("Workers that gained a port on this run."),
    removedWorkers: z.array(z.string().describe("A Worker.")).describe("Workers that went away and released theirs."),
    data: z.boolean().describe("Whether the backend steps ran — migrate then seed. `false` under `--skip-data`."),
  })
  .describe("What `pithy feature sync` reconciled.");

/** `pithy feature destroy --json`. */
const FeatureDestroyPayload = z
  .object({
    command: z.literal("feature.destroy").describe('`"feature.destroy"`.'),
    deletedResources: z
      .array(
        z
          .object({
            kind: z
              .enum(["worker", "d1", "kv", "r2", "queue", "workflow", "vectorize", "artifacts", "artifacts-namespace"])
              .describe(
                "The resource kind. `worker` is a Worker script, `workflow` a Workflow definition, `artifacts` one repo, named `<namespace>/<repo>`, and `artifacts-namespace` the feature's Artifacts namespace, deleted after its repos.",
              ),
            name: z.string().describe("The resource name."),
            id: z.string().describe("The id that was deleted."),
          })
          .describe("One deleted resource."),
      )
      .describe("Every Worker script and Cloudflare resource deleted, scripts first."),
    remote: z.boolean().describe("Whether the remote teardown ran. `false` under `--local-only`."),
    portsFreed: z.boolean().describe("Whether the feature's port block was returned — whether there was one."),
    branch: Branch.describe("The feature branch this run was about, canonically spelled."),
    worktreePruned: z.boolean().describe("Whether a registered worktree was pruned."),
    branchDeleted: z.boolean().describe("Whether the feature branch was deleted. Only when merged."),
    manifestRead: z.boolean().describe("Whether the feature's own `.pithy-feature.json` was read."),
    manifestPath: z.string().describe("Where that manifest is, read or merely named."),
    interrupted: z
      .literal(true)
      .optional()
      .describe("Present only on a teardown that failed partway. `deletedResources` is what went before it."),
  })
  .describe("What `pithy feature destroy` tore down.");

/** `pithy feature prune --json`. */
const FeaturePrunePayload = z
  .object({
    command: z.literal("feature.prune").describe('`"feature.prune"`.'),
    root: z.string().describe("The main checkout root whose blocks were judged."),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. Nothing was written when it is `true`."),
    freedBlocks: z
      .array(OrphanedBlock)
      .describe("The blocks freed, or under `--dry-run` that would be, in port order."),
    plan: PlanKey,
  })
  .describe("What `pithy feature prune` freed, or under `--dry-run` would.");

const create = withContract(
  defineCommand({
    meta: {
      name: "create",
      description: "Stand up a feature's local environment: worktree, ports, dev.vars, migrate + seed",
    },
    args: {
      slug: { type: "positional", required: true, description: "Short kebab-case name, e.g. media-cli" },
      issue: { type: "string", required: true, description: "Issue number this feature tracks" },
      "skip-install": { type: "boolean", default: false, description: "Skip installing dependencies in the worktree" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        // Digits *and* the digit budget, both here. `featureResourceName` reserves `MAX_ISSUE_DIGITS` for
        // the issue segment and refuses anything longer — but it is not reached until provisioning, by
        // which point the branch and the worktree exist. Refusing at the boundary leaves nothing behind.
        if (!/^\d+$/.test(args.issue) || args.issue.length > MAX_ISSUE_DIGITS) {
          throw new ValidationError({
            message: `Issue must be a number of at most ${MAX_ISSUE_DIGITS} digits (got "${args.issue}").`,
            action: "Pass --issue <number>.",
          });
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug)) {
          throw new ValidationError({
            message: `Slug must be kebab-case (got "${args.slug}").`,
            action: "Use lowercase words joined by hyphens, e.g. media-cli.",
          });
        }
        // The branch, the worktree, the registry key and every resource name are composed from this one
        // canonical value, so `012` and `12` are one feature in every half.
        const issue = canonicalIssue(args.issue);

        // Before a branch or a worktree exists: a slug too long for a name this feature would compose.
        // Feature names are never truncated, so the refusal names the longest slug this project takes.
        await assertFeatureSlugFitsProject(projectDir, { issue, slug: args.slug });

        // Capabilities are read from the worktree it creates, not from here: the feature branch is what
        // decides which Workers exist and what each composes.
        const report = await createFeature({
          projectDir,
          issue,
          slug: args.slug,
          skipInstall: args["skip-install"],
        });
        // Only when a branch was actually cut from the trunk. An existing worktree is a no-op and an
        // existing branch is *attached* — its base is whatever somebody else cut, months ago — so a
        // sentence about this trunk would be false on both.
        const behind = report.base === null ? null : await behindRemote();

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ ...report, behindRemote: behind })}\n`);
          return;
        }
        // Said, never refused. The branch was cut from local `main`, which is usually what somebody
        // wants and is sometimes deliberate. Being told is what stops it becoming a surprise at merge time.
        if (behind !== null && report.base !== null) {
          process.stdout.write(
            `${report.base} is ${behind} commit(s) behind origin/${report.base}. ` +
              `Cut from local ${report.base}. git pull to change that.\n`,
          );
        }
        process.stdout.write(`Worktree ${report.worktree}.\n`);
        process.stdout.write(`Branch ${report.branch}.\n`);
        for (const [worker, endpoint] of Object.entries(report.dev.workers)) {
          process.stdout.write(`${worker}: ${endpoint.origin}\n`);
        }
        process.stdout.write("Local backend migrated and seeded.\n");
        const notice = isolatedCheckNotice({
          worktree: report.worktree,
          root: await mainRepoRoot(),
          packageManager: await detectPackageManager(report.worktree),
        });
        for (const line of notice) process.stdout.write(`${line}\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: FeatureCreatePayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

/**
 * `pithy feature sync` — make this worktree's local environment ready, whatever state it is in. Run from
 * the worktree with no arguments; the branch says which feature it is.
 *
 * Two everyday cases, one command. **You added a worker:** it takes the next free port from the feature's
 * already-reserved block and leaves every existing worker where it was. **A colleague pushed the branch and
 * you pulled it:** none of the local state is in git — `.dev.config.json` and the port reservation are both
 * machine-local — so this creates them on your machine (with your own free port block, which is why they
 * are not committed) and brings your local backend up to date. Everything it does is idempotent, so running
 * it when nothing is missing simply reports that nothing moved.
 *
 * **Past the ports it is `pithy setup`, less the install.** One implementation of ready: the check,
 * the local secrets, the `dev` migration, what `pithy dev` does before it starts, and a seed into an empty
 * database. So a Worker's `.dev.vars` is generated here exactly as `pithy dev` generates it, from the
 * same sources — never reconciled, never repaired, and no flag offers to, because a flag promising to fix one
 * sends someone to the wrong command for a file that is not broken.
 */
const sync = withContract(
  defineCommand({
    meta: {
      name: "sync",
      description: "Make this feature's local environment ready: ports, then what pithy setup does",
    },
    args: {
      "skip-data": { type: "boolean", default: false, description: "Reconcile ports only, leaving the backend alone" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const { branch } = await deriveIdentityFromBranch(projectDir);
        const report = await syncFeatureDevConfig({
          mainRoot: await mainRepoRoot(),
          worktreePath: projectDir,
          branch,
        });

        // A freshly-pulled branch has an empty local backend. Everything a clone needs past the ports is
        // `pithy setup`'s, and runs through it: the check, the local secrets, the migration, every
        // Worker's `.dev.vars`, and a seed into an empty database. What the feature adds is its port block,
        // reconciled above. No install: the worktree was installed when it was created.
        let data = false;
        let lines: string[] = [];
        if (!args["skip-data"]) {
          // The account is this worktree's own, never the default credentials file: everything here is
          // local but a media fixture, which reaches Images and Stream — they have no local emulation and
          // belong to exactly one account.
          const account = loadProjectCloudflare(await loadProject(projectDir)) ?? null;
          const result = await setupCheckout({ projectDir, install: false, account });
          // Only a dry run stops at the install, and this is neither.
          if (!isBlockedPlan(result)) {
            lines = [...setupLines(projectDir, result, { feature: true }), ...externalLines(result)];
          }
          data = true;
        }

        if (args.json) {
          // One field, `data`, because there is one flag: migrate and seed both throw, so a run that
          // reaches this line ran both or neither. `migrated` is not used for it because `pithy upgrade`
          // spends that key on the narrower "the migration step ran".
          //
          // `added`/`removed` are published as `addedWorkers`/`removedWorkers`: elsewhere `removed` is a
          // boolean ("was it removed?"), and naming the contents tells the two apart. `SyncReport` keeps
          // its own field names; only what leaves through `--json` is a published name.
          const { added: addedWorkers, removed: removedWorkers, ...rest } = report;
          process.stdout.write(
            `${formatJsonLine({ command: "feature.sync", ...rest, addedWorkers, removedWorkers, data })}\n`,
          );
          return;
        }
        for (const worker of report.added) {
          process.stdout.write(`${worker}: ${report.dev.workers[worker]?.origin} (new).\n`);
        }
        for (const worker of report.removed) {
          process.stdout.write(`${worker}: released.\n`);
        }
        if (report.added.length === 0 && report.removed.length === 0) {
          process.stdout.write("Ports unchanged.\n");
        }
        for (const line of lines) process.stdout.write(`${line}\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: FeatureSyncPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

/**
 * `pithy feature destroy` — teardown. Run from within the worktree, or told which feature with `--branch`.
 *
 * **`--branch` is what makes a merged pull request able to tear its own environment down.** Every
 * other `pithy feature` subcommand infers the feature from the checkout, which is right for a developer
 * and impossible for a runner: on `pull_request: closed` the branch is already deleted and
 * `refs/pull/<n>/head` checks out detached, so there is no branch to read. The pipeline holds the name
 * anyway — `github.event.pull_request.head.ref` is a snapshot in the event payload and outlives the
 * branch — and this is how it says it.
 *
 * Teardown alone, because teardown alone has a caller that cannot be inside the worktree. `provision` and
 * `create` are run by somebody standing in the feature.
 */
const destroy = withContract(
  defineCommand({
    meta: {
      name: "destroy",
      description: "Tear down the feature: delete its Workers and CF resources, free ports, prune the worktree",
    },
    args: {
      env: { type: "string", description: `Environment to tear down (default: "${DEFAULT_FEATURE_ENV}")` },
      branch: {
        type: "string",
        description: "Tear down this feature branch instead of the checkout's, e.g. feature/69-media-cli",
      },
      "local-only": {
        type: "boolean",
        default: false,
        description: "Tear down only the worktree and ports, leaving Cloudflare resources in place",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        /*
        Identity without the Worker configs, and capabilities only if they load. The local half frees the
        port block and prunes the worktree, needs neither, and is most needed when a Worker config will not
        load — a `feature create` that failed partway leaves exactly that. The remote half cannot run
        without them, and skipping it silently would leak every D1/KV/R2 while reporting success, so an
        unloadable config is refused unless `--local-only` says the remote half is not wanted.

        `--branch` names the feature, or the checkout's own branch does, through one parser, refused before
        the config is opened. The **project** comes from this checkout's `pithy.config.ts` either way, which
        keeps the flag from reaching another project's resources.
      */
        const identity = await branchIdentityWithoutWorkers(projectDir, { branch: args.branch });
        /*
        The manifest, the capabilities and the Workers are read from the feature's own worktree when this
        machine has it, so teardown reaches what was actually provisioned. When it does not — a runner —
        the manifest is unreachable and the report says so; the configs come from this checkout, which is
        sound exactly when the workflow checked out `refs/pull/<n>/head`. `docs/commands/feature.md` states
        that rule.
      */
        const record =
          args.branch === undefined
            ? { dir: projectDir, present: true }
            : await featureWorktree({ issue: identity.issue, slug: identity.slug, spelled: identity.spelled });
        const configDir = record.present ? record.dir : projectDir;
        // Resolved once, and composed for `feature` — the environment `provision --feature` composed for:
        // the capabilities name the resources, and the Workers name the scripts. Two
        // resolutions could disagree, and an unstamped one misses a capability a config composes only
        // for deployed environments, leaving its resources and credentials in the account.
        const workerSet = await featureWorkerSet(configDir);
        const capabilities = capabilitySetOf(workerSet);
        if (isUnknown(capabilities) && !args["local-only"]) {
          throw new ValidationError({
            // The set's own diagnosis, which names the worker and says whether the config is broken or
            // simply absent; a sentence written here could name a file that does not exist.
            message: "This project's capability set is unknown, so its resources cannot be deleted.",
            action:
              `${capabilities.unknown} Fix it and re-run, or pass --local-only to free this feature's ports ` +
              "and prune its worktree without touching Cloudflare.",
          });
        }
        // `--local-only` resolves no account: the local half never reaches Cloudflare, so a shell holding
        // another account's credentials is not refused. The remote half resolves, and refuses on a mismatch.
        const remote = args["local-only"] ? null : await remoteHalf(projectDir, configDir, identity.project);
        // Both seams or neither, whichever way the remote half is skipped.
        const teardown: RemoteTeardown = remote?.teardown ?? {};
        let report: DestroyReport;
        try {
          report = await destroyFeature({
            projectDir,
            identity,
            capabilities: isUnknown(capabilities) ? [] : [...capabilities],
            workers: isUnknown(workerSet) ? [] : workerSet,
            ...(remote?.store ? { store: remote.store } : {}),
            env: requireEnvironment(args.env ?? DEFAULT_FEATURE_ENV),
            // Which worktree is the feature's own, and whether this machine has it.
            record,
            // The spelling the branch actually used, for the local half's fallback. Every
            // name is composed from the canonical issue; only the worktree, the branch and the port key
            // may have been filed under `012`.
            spelled: identity.spelled,
            ...teardown,
            // `capabilities`, not `capabilities ?? []`. The teardown below takes the empty set because with
            // `--local-only` there is nothing remote to reconcile, but auditing must not read *unknowable*
            // as *this project composed no trail*. Only the remote half records through it, so
            // `--local-only` builds none.
            ...(remote ? { audit: await buildAudit(projectDir, capabilities, remote.account) } : {}),
          });
        } catch (error) {
          // A teardown that failed on the fourth delete has already destroyed three. What went is written
          // to stdout here, then the same error
          // is rethrown for `withErrorReporting` to render on stderr and exit by its kind — both streams and the
          // exit code agreeing that it failed and naming what it destroyed on the way.
          const partial = destroyedBeforeFailure(error);
          if (partial) {
            if (args.json) {
              const { command, deleted: deletedResources, ...rest } = partial;
              process.stdout.write(`${formatJsonLine({ command, deletedResources, ...rest, interrupted: true })}\n`);
            } else {
              for (const resource of partial.deleted) process.stdout.write(`Deleted ${resource.name}.\n`);
              // Only after something went. "Teardown stopped there. The rest is still in the account" is
              // true of a partial delete and false before the first one — there is no *rest* when nothing
              // went, and the error on stderr is the whole story.
              if (partial.deleted.length > 0) {
                process.stdout.write(
                  "Teardown stopped there. The rest is still in the account, and in the manifest.\n",
                );
              }
            }
          }
          throw error;
        }

        if (args.json) {
          // `deleted` is published as `deletedResources`: `pithy vector reset` emits a `deleted` that is a
          // `string[]` of index names, and this one is `{kind,name,id}[]`, opposite provisioning's
          // `resources`. `DestroyReport` keeps `deleted`; the published name is decided here.
          const { command, deleted: deletedResources, ...rest } = report;
          process.stdout.write(`${formatJsonLine({ command, deletedResources, ...rest })}\n`);
          return;
        }
        for (const resource of report.deleted) {
          process.stdout.write(`Deleted ${resource.name}.\n`);
        }
        if (!report.remote) process.stdout.write("Remote teardown skipped. Cloudflare resources were left in place.\n");
        // **The record it could not consult, named.** The manifest is the only way to reach a
        // resource whose binding the branch has since dropped, and a runner has no copy of it. A teardown
        // that quietly deletes less than it would have is the failure this command spends a paragraph
        // forbidding, so the narrowing is a sentence rather than a shorter list nobody counted.
        // Only when the remote half actually ran: with `--local-only` nothing was deleted remotely at all,
        // and the line above has already said so. A second sentence about a record it did not need would
        // read as a warning about a run that was never going to touch the account.
        if (report.remote && !report.manifestRead) {
          process.stdout.write(`No feature manifest at ${report.manifestPath}.\n`);
          // True whether the file was absent or the whole worktree was: what went is what the branch and
          // this checkout's config name, and a resource recorded only there is still in the account.
          process.stdout.write("Deleted by recomputed name alone; anything only it recorded is still there.\n");
        }
        if (report.worktreePruned) process.stdout.write("Worktree pruned.\n");
        if (report.branchDeleted) process.stdout.write(`Branch ${report.branch} deleted.\n`);
        // **Said, because nothing else would say it.** A runner tearing down a merged feature has no
        // worktree, no port block and no branch — all three are machine-local and the machine is a fresh
        // container — so the local half has nothing to do, and a run that printed only what it deleted
        // remotely would leave an operator wondering whether it was skipped or simply silent. Nothing to do
        // is an outcome; anything at all having happened is not, which is why every field is read.
        if (!report.portsFreed && !report.worktreePruned && !report.branchDeleted) {
          process.stdout.write("No port block and no worktree here. Nothing local to tear down.\n");
        }
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    // 2: `deletedResources[].kind` takes `queue`, beside `workflow` and `vectorize`.
    // 3: it takes `artifacts`, one repo in the feature's own Artifacts namespace, and `artifacts-namespace`, that
    // namespace itself.
    schemaVersion: 3,
    payload: FeatureDestroyPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);

/**
 * `pithy feature prune` — free the port blocks of features whose worktree directory and branch are both gone.
 * Run from the project directory of any checkout of the repository, where `pithy dev` runs.
 *
 * `destroy` frees a feature's block, and has to be run from inside the worktree to know which. A worktree
 * removed any other way — `git worktree prune`, an adopter's own teardown, a directory deleted by hand —
 * leaves nothing to run it from, so its block is freed here.
 *
 * **Not run for you on allocation**, unlike the sweep of dead checkouts. That sweep asks the filesystem one
 * `stat` per root; this asks git several questions and walks every worktree, inside the registry lock, on a
 * machine-wide file shared with projects that may not be repositories at all. A command someone chose to run
 * is the right cost.
 */
const prune = withContract(
  defineCommand({
    meta: {
      name: "prune",
      description: "Free the port blocks of features whose worktree and branch are both gone",
    },
    args: {
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const registryPath = portsRegistryPath();
        const report = await pruneFeatureBlocks({ cwd: process.cwd(), registryPath, dryRun: args["dry-run"] });

        if (args.json) {
          const plan = report.dryRun ? prunePlan(report, registryPath) : undefined;
          process.stdout.write(
            `${formatJsonLine({ command: "feature.prune", root: report.root, dryRun: report.dryRun, freedBlocks: report.freedBlocks, plan })}\n`,
          );
          return;
        }
        const verb = report.dryRun ? "Would free" : "Freed";
        for (const entry of report.freedBlocks) {
          process.stdout.write(`${verb} ${entry.base}–${entry.base + entry.size - 1}, ${entry.branch}.\n`);
        }
        if (report.freedBlocks.length === 0) process.stdout.write("Nothing to free.\n");
        process.stdout.write(report.dryRun ? "Dry run. Nothing written.\n" : `${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    // 2: `plan.resources[].kind` takes `queue`, the fourth kind provisioning creates.
    schemaVersion: 2,
    payload: FeaturePrunePayload,
    mutates: true,
    idempotent: true,
    needsNetwork: false,
  },
);

export default defineCommand({
  meta: { name: "feature", description: "Set up and tear down an isolated, fully-provisioned feature environment" },
  subCommands: { create, sync, destroy, prune },
});
