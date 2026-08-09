// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineCommand } from "citty";
import { availableManifests, type ManifestFault } from "../capabilities/manifests";
import {
  applyReconcilePlan,
  buildReconcilePlan,
  type CountPending,
  type ReconcileApplied,
  type ReconcilePlan,
  type RunMigrate,
} from "../capabilities/reconcile";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { envArg, requireEnvironment } from "../project/environment";
import { resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy upgrade [--env] [--worker <name>] [--dry-run] [--migrate]` — reconcile every Worker with the
 * capability manifests installed in the project.
 *
 * Capabilities are per Worker, so the reconcile engine is too: `upgrade` fans out over `apps/*`, building and
 * applying one plan per Worker against that Worker's own `pithy.config.ts` and `wrangler.jsonc`. Output is
 * grouped by Worker — a project with two Workers gets two blocks, and `--json` carries one entry each.
 * `--worker <name>` narrows the run to one.
 */

/** The minimum `upgrade` needs to know about a Worker. `ResolvedWorker` satisfies it structurally. */
export interface UpgradeWorker {
  /** The Worker's name, as `pithy worker list` shows it. */
  name: string;
  /** The Worker's directory (`apps/<name>/`) — the wiring a plan reads and an apply writes. */
  dir: string;
  /** The capabilities that Worker's own `pithy.config.ts` composes. */
  capabilities: Capability[];
}

/** Options for {@link runUpgrade} — every filesystem and migration dependency is injectable for tests. */
export interface UpgradeRunOptions {
  /** The project root — the parent of `apps/`, and where the capability manifests resolve from. */
  projectDir: string;
  /** The environment the pending-migration count (and any `--migrate` run) targets. */
  env: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required (#234): `--migrate --env staging` applies migrations to a live
   * schema, which is the write this must never make under credentials the project did not claim.
   */
  account: CloudflareAccountSelection | null;
  /** Narrow the fan-out to one Worker, by name or `apps/<dir>` basename. */
  worker?: string;
  /** Build the plans without applying them. */
  dryRun: boolean;
  /** Run each Worker's pending migrations after reconciling it. */
  migrate: boolean;
  /** Worker-set resolver seam; defaults to {@link resolveWorkers}. */
  resolveWorkers?: (options: { projectDir: string; worker?: string }) => Promise<UpgradeWorker[]>;
  /** Test seam: count pending migrations without a real Miniflare/D1 run. */
  countPending?: CountPending;
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
  /** Test seam: substitute the manifest scan. Defaults to the real `node_modules/@pithy-sh` read. */
  readManifests?: (projectDir: string) => Promise<{ faults: ManifestFault[] }>;
}

/** One Worker's outcome: the plan built for it, and what applying it changed (absent on a dry run). */
export interface UpgradeWorkerResult {
  plan: ReconcilePlan;
  applied: ReconcileApplied | null;
}

/**
 * What one `pithy upgrade` run produced: a result per Worker, and the manifests it could not read.
 *
 * The faults are project-wide, not per Worker — manifests install once under the root's
 * `node_modules/@pithy-sh` and every Worker shares them — so they are reported once, above the Workers.
 * They used to be reported nowhere at all: a manifest the schema refused made its capability vanish from
 * every plan, and the run reconciled happily around the hole (#184).
 */
export interface UpgradeRun {
  /** One entry per Worker in scope, in discovery order. */
  workers: UpgradeWorkerResult[];
  /** Installed packages whose `pithy.manifest.json` is present and unusable. Empty on a healthy install. */
  manifestFaults: ManifestFault[];
}

/**
 * The project name the proposed resource names lead with — resolved here, at the command edge, and handed
 * to the apply step as a plain string. The same helper `pithy add` uses, for the same reason: a capability
 * wired by `upgrade` must get the same `<project>-<env>-<binding>` database name it would have got from
 * `add`, or one route into the project leaves nameless resources behind.
 *
 * `requireProjectName`, never `resolveProjectName`: a proposal has to be the name every later command
 * recomputes, and the lenient resolver's fallbacks differ between checkouts. A project with no `name` gets
 * no proposal rather than a guess — the entries carry only their binding, and `pithy doctor` says why.
 */
async function proposalProject(projectDir: string): Promise<string | undefined> {
  try {
    return requireProjectName(await loadProject(projectDir));
  } catch {
    return undefined;
  }
}

/**
 * Reconcile every Worker in scope, in discovery order. Each Worker gets its own plan, built from and (unless
 * `dryRun`) applied to its own `apps/<name>/` wiring — no Worker's drift can reach another's files.
 */
export async function runUpgrade(options: UpgradeRunOptions): Promise<UpgradeRun> {
  const resolve = options.resolveWorkers ?? resolveWorkers;
  const scan = options.readManifests ?? availableManifests;
  const { faults } = await scan(options.projectDir);
  const workers = await resolve({
    projectDir: options.projectDir,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
  });
  const project = options.dryRun ? undefined : await proposalProject(options.projectDir);

  const results: UpgradeWorkerResult[] = [];
  for (const worker of workers) {
    const plan = await buildReconcilePlan({
      projectDir: options.projectDir,
      workerDir: worker.dir,
      worker: worker.name,
      env: options.env,
      account: options.account,
      capabilities: worker.capabilities,
      ...(options.countPending ? { countPending: options.countPending } : {}),
    });
    if (options.dryRun) {
      results.push({ plan, applied: null });
      continue;
    }
    const applied = await applyReconcilePlan({
      projectDir: options.projectDir,
      workerDir: worker.dir,
      plan,
      migrate: options.migrate,
      env: options.env,
      account: options.account,
      ...(project === undefined ? {} : { project }),
      capabilities: worker.capabilities,
      ...(options.runMigrate ? { runMigrate: options.runMigrate } : {}),
    });
    results.push({ plan, applied });
  }
  return { workers: results, manifestFaults: faults };
}

/** `"2 bindings"` / `"1 binding"` — count with a singular/plural noun, omitted when zero. */
function count(n: number, noun: string): string | null {
  if (n === 0) return null;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Join the non-empty parts of a per-capability summary into one sentence, or null when nothing changed. */
function parts(bindings: number, keys: number, verb: string): string | null {
  const pieces = [count(bindings, "binding"), count(keys, "config key")].filter(
    (piece): piece is string => piece !== null,
  );
  if (pieces.length === 0) return null;
  return `${verb} ${pieces.join(", ")}.`;
}

/**
 * The warning lines for a manifest that is installed and unusable.
 *
 * A capability with a fault here is in no other line of the report: its manifest could not be read, so it
 * contributes no drift, no bindings, and no config keys, and the run reconciles happily around the hole.
 * That silence is what #184 was reported about — `upgrade` is one of the three commands an adopter runs
 * when a capability has gone missing, and it was one of the three that said nothing.
 */
function faultLines(faults: readonly ManifestFault[]): string[] {
  return faults.flatMap((fault) => [
    `${fault.package}: malformed pithy.manifest.json. Not reconciled.`,
    ...fault.reason.split("\n").map((line) => `  ${line}`),
  ]);
}

/** The human-readable lines for one Worker's dry-run plan. */
function planLines(plan: ReconcilePlan): string[] {
  const lines: string[] = [];
  for (const cap of plan.perCapability) {
    const summary = parts(cap.missingBindings.length, cap.missingConfigKeys.length, "add");
    if (summary) lines.push(`${cap.name}: ${summary}`);
  }
  for (const name of plan.ejectedSkipped) lines.push(`${name}: ejected. Skipped.`);
  if (plan.missingVersionMetadata) lines.push("version_metadata: add CF_VERSION_METADATA.");
  if (plan.pendingMigrations > 0) {
    const pending = count(plan.pendingMigrations, "migration");
    lines.push(`${pending} pending. Run pithy upgrade --migrate, or pithy migrate --env ${plan.env}.`);
  }
  if (lines.length === 0) lines.push("Nothing to upgrade.");
  return lines;
}

/** The human-readable lines for one Worker's applied upgrade. */
function appliedLines(applied: ReconcileApplied, plan: ReconcilePlan): string[] {
  const lines: string[] = [];
  for (const cap of applied.perCapability) {
    const summary = parts(cap.addedBindings.length, cap.addedConfigKeys.length, "added");
    if (summary) lines.push(`${cap.name}: ${summary}`);
  }
  for (const name of applied.ejectedSkipped) lines.push(`${name}: ejected. Skipped.`);
  if (applied.addedVersionMetadata) lines.push("version_metadata: added CF_VERSION_METADATA.");
  else if (plan.missingVersionMetadata) lines.push("version_metadata: names another binding. Left alone.");
  if (applied.migrated) {
    const total = applied.migrations.reduce((sum, run) => sum + run.results.length, 0);
    lines.push(total === 0 ? "Migrations up to date." : `Migrated ${count(total, "migration")}.`);
  } else if (plan.pendingMigrations > 0) {
    const pending = count(plan.pendingMigrations, "migration");
    lines.push(`${pending} pending. Run pithy upgrade --migrate, or pithy migrate --env ${plan.env}.`);
  }
  if (lines.length === 0) lines.push("Nothing to upgrade.");
  return lines;
}

/**
 * Group each Worker's lines under its name: the name on its own line, its lines indented beneath. Every
 * Worker in scope appears, including one with nothing to do — the run covered it, and silence would read
 * as "skipped".
 */
function renderUpgrade(run: UpgradeRun): string[] {
  // Above the Workers, because it is not any Worker's fault and it explains a gap in all of them.
  const lines: string[] = faultLines(run.manifestFaults);
  for (const { plan, applied } of run.workers) {
    lines.push(`${plan.worker}:`);
    for (const line of applied ? appliedLines(applied, plan) : planLines(plan)) lines.push(`  ${line}`);
  }
  return lines;
}

export default defineCommand({
  meta: {
    name: "upgrade",
    description: "Reconcile each worker's installed capabilities with its pithy.config.ts and wrangler.jsonc",
  },
  args: {
    env: envArg("Target environment (drives the pending-migration count)"),
    worker: { type: "string", description: "Upgrade only this worker (default: every worker under apps/)" },
    "dry-run": { type: "boolean", default: false, description: "Show the plan without writing anything" },
    migrate: { type: "boolean", default: false, description: "Run pending migrations after reconciling" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const dryRun = args["dry-run"];
      const projectDir = process.cwd();
      const run = await runUpgrade({
        projectDir,
        env,
        account: await projectCloudflareAccount(projectDir),
        ...(args.worker ? { worker: args.worker } : {}),
        dryRun,
        migrate: args.migrate,
      });

      if (args.json) {
        const workers = run.workers.map(({ plan, applied }) => applied ?? plan);
        process.stdout.write(
          `${formatJsonLine({ command: "upgrade", env, dryRun, workers, manifestFaults: run.manifestFaults })}\n`,
        );
        return;
      }

      for (const line of renderUpgrade(run)) process.stdout.write(`${line}\n`);
      process.stdout.write(dryRun ? "Dry run. Nothing written.\n" : `${formatDone()}\n`);
    }),
});

// Exposed for the command test to exercise the render helpers directly (run() stays thin and untested).
export const __test = { planLines, appliedLines, renderUpgrade, parts, count };
