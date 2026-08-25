// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { MAX_ISSUE_DIGITS } from "@pithy-sh/core/src/naming/limits";
import { defineCommand } from "citty";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareAccountConfirmation, cloudflareEnv } from "../cloudflare/config";
import { createFeature } from "../feature/create";
import { type DestroyReport, destroyedBeforeFailure, destroyFeature } from "../feature/destroy";
import {
  branchIdentity,
  branchIdentityWithoutWorkers,
  deriveIdentityFromBranch,
  projectCapabilitiesOrNull,
} from "../feature/identity";
import { syncFeatureDevConfig } from "../feature/sync";
import { behindRemote, mainRepoRoot } from "../feature/worktree";
import { migrateProject } from "../migrations/run";
import { loadProject, loadProjectCloudflare, projectCloudflareAccount, requireProjectName } from "../project/config";
import { requireEnvironment } from "../project/environment";
import { AUDIT_DESTINATION_ENV, cloudflareProvisioners, type ResourceProvisioners } from "../provision/resources";
import { cloudflareSecretsStore, type SecretsStore } from "../provision/store";
import { seedProject } from "../seed/run";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * The feature's own ephemeral CF environment.
 *
 * `destroy` takes an `--env` because it names the environment its audit trail records; it deletes by
 * recomputed feature name regardless, so the flag never changes what goes. Standing the environment up is
 * `pithy provision --feature`'s job — one job with two spellings, and this is not one of them.
 */
const DEFAULT_FEATURE_ENV = FEATURE_ENVIRONMENT;

/** Build the CF control-plane provisioners from the environment's credentials, or null when they are absent. */
function buildProvisioners(account: CloudflareAccountSelection | null): ResourceProvisioners | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  // What vouches for that id travels with it (#378). `find` is find-or-create's first half, and an empty
  // listing from an account nothing claims is not the absence the second half reads it as.
  const confirmation = cloudflareAccountConfirmation({ account });
  return cloudflareProvisioners(new CloudflareClients({ accountId, apiToken }), { accountId, confirmation });
}

/**
 * The account's Secrets Store, or `null` when this project has not recorded one.
 *
 * **Absent is a degraded feature environment, never a failed command.** A project that composes no
 * `secrets` capability has no store id and needs none; one that does gets its own master key and its
 * `secrets_store_secrets` bindings. Either way the rest of the feature stands up, and the report says
 * which happened.
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
  capabilities: Capability[],
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
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** `pithy feature create <slug> --issue <n>` — local, automatic. Run from the main checkout. */
const create = defineCommand({
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

      // Capabilities are read from the worktree it creates, not from here: the feature branch is what
      // decides which Workers exist and what each composes.
      const report = await createFeature({
        projectDir,
        issue: args.issue,
        slug: args.slug,
        skipInstall: args["skip-install"],
      });
      const behind = await behindRemote();

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report, behindRemote: behind })}\n`);
        return;
      }
      // Said, never refused — `#454`. The branch was cut from local `main`, which is usually what somebody
      // wants and is sometimes deliberate. Being told is what stops it becoming a surprise at merge time.
      if (behind !== null) {
        process.stdout.write(
          `main is ${behind} commit(s) behind origin/main. Cut from local main. git pull to change that.\n`,
        );
      }
      process.stdout.write(`Worktree ${report.worktree}.\n`);
      process.stdout.write(`Branch ${report.branch}.\n`);
      for (const [worker, endpoint] of Object.entries(report.dev.workers)) {
        process.stdout.write(`${worker}: ${endpoint.origin}\n`);
      }
      process.stdout.write("Local backend migrated and seeded.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});

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
 * **It touches no `.dev.vars`, and its help text must not offer to.** Each Worker's is generated by
 * `pithy dev` from sources already on this machine (#154), so there is nothing here to reconcile — and a
 * flag whose description promises otherwise sends someone to the wrong command for a file that is not
 * broken.
 */
const sync = defineCommand({
  meta: {
    name: "sync",
    description: "Make this feature's local environment ready: ports, migrate + seed",
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

      // A freshly-pulled branch has an empty local backend; both steps are idempotent when it is not.
      // Each fans out over the worktree's Workers, so a Worker the branch added is covered without asking.
      let data = false;
      if (!args["skip-data"]) {
        // Both steps name the project, resolved once. The migrate stamps each database as this
        // project's — the check that refuses another project's D1 — and the seed carries the same name
        // into the account-wide Images/Stream stores, which is all a later sweep has to go on.
        // One config load, two facts (#234). The account is this worktree's own, never the default
        // credentials file: a `dev` fan-out is local, but a media fixture reaches Images and Stream,
        // which have no local emulation and belong to exactly one account.
        const config = await loadProject(projectDir);
        const project = requireProjectName(config);
        const account = loadProjectCloudflare(config) ?? null;
        await migrateProject({ env: "dev", projectDir, project, account });
        await seedProject({ env: "dev", projectDir, project, account, json: true });
        data = true;
      }

      if (args.json) {
        // **One field, `data`, because there is one flag (#231).** It used to emit `migrated: data,
        // seeded: data` — two keys off one boolean, so they can never disagree, so every consumer's
        // `if (migrated && !seeded)` is a branch that can never fire and can never be tested. Should the
        // steps ever be split, that dead branch silently becomes live with whatever meaning the split
        // invents. `migrated` is also already taken: on `pithy upgrade` it means the narrower "the
        // migration step ran", so `feature sync` spending it on "migrated *and* seeded" was itself a
        // shared key with two meanings — the defect #231 is about. Two facts that can differ is not on
        // offer either: both steps throw, so any run that reaches this line ran both or neither.
        //
        // **`added`/`removed` are published as `addedWorkers`/`removedWorkers` (#235).** `removed` is
        // `boolean` on `pithy alias --remove` and on `pithy dashboard disconnect` — "was it removed?" —
        // and a `string[]` here, so `if (result.removed)` is true for both and means opposite things.
        // The collection is the outlier, and naming its contents is what tells the two apart; `added`
        // comes with it because the pair is read together, and half a qualified pair invites exactly the
        // misreading the qualification is for. The report keeps its own field names: `SyncReport` is the
        // reconciler's domain type, and only what leaves through `--json` is a published name.
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
      if (data) process.stdout.write("Local backend migrated and seeded.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});

/** `pithy feature destroy` — teardown. Run from within the worktree. */
const destroy = defineCommand({
  meta: { name: "destroy", description: "Tear down the feature: delete CF resources, free ports, prune the worktree" },
  args: {
    env: { type: "string", description: `Environment to tear down (default: "${DEFAULT_FEATURE_ENV}")` },
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
        Identity without the Worker configs, and capabilities only if they load — `#454`.

        Teardown's local half frees the port block and prunes the worktree, and needs neither. It is also
        the half most needed when a Worker config will not load: a `feature create` that failed partway
        leaves exactly that, and `destroy` used to throw on the same config before reaching the teardown —
        so the command that frees the block was unavailable in the state that produced the leak.

        The remote half genuinely cannot run without them, and skipping it silently is the worst outcome
        (every D1/KV/R2 leaks while the run reports success). So an unloadable config is refused unless
        `--local-only` says the remote half is not wanted.
      */
      const identity = await branchIdentityWithoutWorkers(projectDir);
      const capabilities = await projectCapabilitiesOrNull(projectDir);
      if (capabilities === null && !args["local-only"]) {
        throw new ValidationError({
          message: "This project's Worker configuration will not load, so its resources cannot be deleted.",
          action:
            "Fix the config and re-run, or pass --local-only to free this feature's ports and prune its " +
            "worktree without touching Cloudflare.",
        });
      }
      const account = await projectCloudflareAccount(projectDir);
      const provisioners = buildProvisioners(account);

      // Without credentials the remote half cannot run. Skipping it silently is the worst outcome: every
      // D1/KV/R2 leaks while the run reports success, and teardown then deletes the branch the resource
      // names are derived from — so a later attempt can no longer work out what to delete. A CI job whose
      // credentials did not propagate must fail loudly. `--local-only` is the deliberate opt-out.
      if (!provisioners && !args["local-only"]) {
        throw new ValidationError({
          message: "Cloudflare credentials are missing, so the feature's resources cannot be deleted.",
          action:
            "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to tear down the remote environment, " +
            "or pass --local-only to remove just the worktree and its ports.",
        });
      }

      const store = buildStore(account);
      let report: DestroyReport;
      try {
        report = await destroyFeature({
          projectDir,
          identity,
          capabilities: capabilities ?? [],
          ...(store && !args["local-only"] ? { store } : {}),
          env: requireEnvironment(args.env ?? DEFAULT_FEATURE_ENV),
          ...(provisioners && !args["local-only"] ? { provisioners } : {}),
          audit: await buildAudit(projectDir, capabilities ?? [], account),
        });
      } catch (error) {
        // A teardown that failed on the fourth delete has already destroyed three, and until #380 the
        // record of them died with the throw. What went is written to stdout here, then the same error
        // is rethrown for `withErrorReporting` to render on stderr and exit 1 on — both streams and the
        // exit code agreeing that it failed and naming what it destroyed on the way.
        const partial = destroyedBeforeFailure(error);
        if (partial) {
          if (args.json) {
            const { command, deleted: deletedResources, ...rest } = partial;
            process.stdout.write(`${formatJsonLine({ command, deletedResources, ...rest, interrupted: true })}\n`);
          } else {
            for (const resource of partial.deleted) process.stdout.write(`Deleted ${resource.name}.\n`);
            process.stdout.write("Teardown stopped there. The rest is still in the account, and in the manifest.\n");
          }
        }
        throw error;
      }

      if (args.json) {
        // **`deleted` is published as `deletedResources` (#235).** `pithy vector reset` emits a `deleted`
        // too, and its is a `string[]` of index names where this one is `{kind,name,id}[]`. Two
        // collections under one name is the harder half of the collision to notice — both are truthy,
        // both have a `.length` — so the fix is to say what each holds. This is the record-shaped one,
        // and `deletedResources` also puts it opposite provisioning's `resources`, which is the
        // list it undoes. `DestroyReport` keeps `deleted`: it is teardown's own vocabulary, and the
        // published name is decided here, where the payload is.
        const { command, deleted: deletedResources, ...rest } = report;
        process.stdout.write(`${formatJsonLine({ command, deletedResources, ...rest })}\n`);
        return;
      }
      for (const resource of report.deleted) {
        process.stdout.write(`Deleted ${resource.name}.\n`);
      }
      if (!report.remote) process.stdout.write("Remote teardown skipped. Cloudflare resources were left in place.\n");
      if (report.worktreePruned) process.stdout.write("Worktree pruned.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});

export default defineCommand({
  meta: { name: "feature", description: "Set up and tear down an isolated, fully-provisioned feature environment" },
  subCommands: { create, sync, destroy },
});
