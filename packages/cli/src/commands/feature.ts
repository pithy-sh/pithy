// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { MAX_ISSUE_DIGITS } from "@pithy-sh/core/src/naming/limits";
import { defineCommand } from "citty";
import { type CliAuditEmit, createCliAudit } from "../audit/cliAudit";
import { cloudflareEnv } from "../cloudflare/config";
import { createFeature } from "../feature/create";
import { destroyFeature } from "../feature/destroy";
import { deriveIdentityFromBranch } from "../feature/identity";
import { cloudflareProvisioners, type FeatureProvisioners, provisionFeature } from "../feature/provision";
import { syncFeatureDevConfig } from "../feature/sync";
import { mainRepoRoot } from "../feature/worktree";
import { migrateProject } from "../migrations/run";
import { loadProject, requireProjectName } from "../project/config";
import { requireEnvironment } from "../project/environment";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { seedProject } from "../seed/run";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/** The feature's own ephemeral CF environment — provision/destroy default here unless `--env` names another. */
const DEFAULT_FEATURE_ENV = "feature";

/** Build the CF control-plane provisioners from the environment's credentials, or null when they are absent. */
function buildProvisioners(): FeatureProvisioners | null {
  const vars = cloudflareEnv();
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return null;
  return cloudflareProvisioners(new CloudflareClients({ accountId, apiToken }));
}

/**
 * Where a feature's audit trail is written. **Not the feature's own environment.**
 *
 * The feature env's database does not exist yet when `provision` starts — its id is written into
 * `wrangler.jsonc` only once the resources are created — so keying the audit database on it would resolve
 * nothing and silently drop every creation event. And `destroy` deletes that database, so a record written
 * there dies with the thing it was recording. Both defeat the point of auditing a headless CI teardown.
 *
 * So the trail lands in the project's durable, top-level database: it outlives every feature, and it is
 * where an operator looks to answer "who tore this down?". The environment actually acted on is stated by
 * each event, and lands in the row's own `environment` column.
 */
const AUDIT_DESTINATION_ENV = "dev";

/**
 * The audit emitter for a feature command, or a no-op when auditing is unavailable. Feature provisioning
 * and teardown change real infrastructure — and `destroy` runs headlessly in CI — so every create and
 * delete leaves a record of what happened under which token. Credentials are the same ones the command
 * already needs; without them there is nothing to record through and the emitter is inert.
 *
 * These are control-plane operations: they touch real Cloudflare whatever environment is named, so they use
 * `createCliAudit` directly rather than the remote-gated variant, and are always recorded.
 */
async function buildAudit(projectDir: string, capabilities: Capability[]): Promise<CliAuditEmit> {
  const vars = cloudflareEnv();
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

/**
 * Resolve the feature identity (project + issue + slug) from the current branch and the root config, plus
 * the capabilities the feature spans.
 *
 * The two come from different places, deliberately. **Identity** is project-wide policy and lives in the
 * root `pithy.config.ts`. **Capabilities** are per Worker (`apps/<name>/pithy.config.ts`), so they are
 * unioned: a feature provisions one resource per binding name for the whole feature — two Workers that both
 * declare `DB` deliberately share one database — and the migrate/seed it runs must cover every table any
 * Worker owns.
 */
async function branchIdentity(projectDir: string): Promise<{ identity: FeatureIdentity; capabilities: Capability[] }> {
  const { issue, slug } = await deriveIdentityFromBranch(projectDir);
  const config = await loadProject(projectDir);
  // Never guessed: this name is the first segment of every resource name, and the only key teardown has
  // to find them again. A fallback that differs between a worktree and a clone would make destroy
  // recompute names that match nothing, delete nothing, and exit 0 — a silent leak.
  const project = requireProjectName(config);
  const capabilities = projectCapabilities(await resolveWorkers({ projectDir }));
  return { identity: { project, issue, slug }, capabilities };
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

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report })}\n`);
        return;
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
        const project = requireProjectName(await loadProject(projectDir));
        await migrateProject({ env: "dev", projectDir, project });
        await seedProject({ env: "dev", projectDir, project, json: true });
        data = true;
      }

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "feature.sync", ...report, migrated: data, seeded: data })}\n`,
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

/** `pithy feature provision [--env <name>]` — remote, explicit. Run from within the worktree. */
const provision = defineCommand({
  meta: {
    name: "provision",
    description: "Provision the feature's live Cloudflare environment, then migrate + seed it",
  },
  args: {
    env: {
      type: "string",
      description: `Target environment (default: the feature's own "${DEFAULT_FEATURE_ENV}" env)`,
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const { identity, capabilities } = await branchIdentity(projectDir);
      const provisioners = buildProvisioners();
      if (!provisioners) {
        throw new ValidationError({
          message: "Cloudflare credentials are missing.",
          action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to provision a feature environment.",
        });
      }

      const env = requireEnvironment(args.env ?? DEFAULT_FEATURE_ENV);
      const report = await provisionFeature({
        projectDir,
        env,
        capabilities,
        identity,
        provisioners,
        audit: await buildAudit(projectDir, capabilities),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report })}\n`);
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
      process.stdout.write(`Provisioned ${report.env}. Migrated and seeded.\n`);
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
      const { identity, capabilities } = await branchIdentity(projectDir);
      const provisioners = buildProvisioners();

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

      const report = await destroyFeature({
        projectDir,
        identity,
        capabilities,
        env: requireEnvironment(args.env ?? DEFAULT_FEATURE_ENV),
        ...(provisioners && !args["local-only"] ? { provisioners } : {}),
        audit: await buildAudit(projectDir, capabilities),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report })}\n`);
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
  subCommands: { create, sync, provision, destroy },
});
