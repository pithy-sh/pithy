// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineCommand } from "citty";
import { availableManifests, type ManifestFault } from "../capabilities/manifests";
import {
  applyReconcilePlan,
  buildReconcilePlan,
  type ReadLedger,
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
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
  /** Test seam: substitute the manifest scan. Defaults to the real `node_modules/@pithy-sh` read. */
  readManifests?: (projectDir: string) => Promise<{ faults: ManifestFault[] }>;
}

/**
 * One Worker's outcome — **three states, and the plan lives behind the one that has it** (#380).
 *
 * A plan reads that Worker's own `pithy.config.ts` and `wrangler.jsonc` and, through the ledger, its
 * databases; an apply *writes* those files and, with `--migrate`, runs that Worker's migrations. All of
 * it can fail for reasons belonging to one Worker, and the throw used to propagate out of the fan-out —
 * so a five-Worker project lost four Workers' reports to the fifth's broken config, and, worse than its
 * twin in `buildProjectHealth`, lost them *after* some of those Workers' files had already been
 * rewritten.
 *
 * `unplanned` and `unapplied` are kept apart because the difference is whether anything was written.
 * Nothing was read about an `unplanned` Worker and nothing was changed. An `unapplied` Worker had a plan
 * and the apply died inside it: its `wrangler.jsonc` may hold some of the bindings, its `pithy.config.ts`
 * some of the keys, and under `--migrate` its schema may have moved. Collapsing the two would tell an
 * operator to re-run a command against a Worker in an unknown state as though it were untouched.
 *
 * The state rides on the value, so `result.plan` does not compile without narrowing and an unreconciled
 * Worker cannot be rendered as a reconciled one.
 */
export type UpgradeWorkerResult =
  | {
      /** The plan was built, and applied unless this was a dry run. */
      state: "reconciled";
      /** The Worker's name, as `pithy worker list` shows it. */
      worker: string;
      /** What this run found to do. */
      plan: ReconcilePlan;
      /** What applying it changed. `null` on a dry run, which wrote nothing by design. */
      applied: ReconcileApplied | null;
    }
  | {
      /** The plan could not be built. Nothing was read about this Worker, and nothing was written. */
      state: "unplanned";
      /** The Worker's name — the one actionable fact, and the only one this carries. */
      worker: string;
    }
  | {
      /** The plan was built and applying it failed partway. This Worker's files may already have changed. */
      state: "unapplied";
      /** The Worker's name. */
      worker: string;
      /** What the run set out to do. What of it landed is not established — that is the whole of this state. */
      plan: ReconcilePlan;
    };

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
    // Guarded per Worker, and `try`/`catch` rather than `.catch()`: a plan that throws before it returns
    // a promise — a `pithy.config.ts` that will not import, a `wrangler.jsonc` the parser refuses — is
    // not a rejected promise, and a `.catch()` would not see it (#371).
    //
    // The guards take no binding. The Worker's name is what an operator acts on, and what a config load
    // or a D1 read throws names a path, an id, or a query.
    let plan: ReconcilePlan;
    try {
      plan = await buildReconcilePlan({
        projectDir: options.projectDir,
        workerDir: worker.dir,
        worker: worker.name,
        env: options.env,
        account: options.account,
        capabilities: worker.capabilities,
        ...(options.readLedger ? { readLedger: options.readLedger } : {}),
      });
    } catch {
      results.push({ state: "unplanned", worker: worker.name });
      continue;
    }
    if (options.dryRun) {
      results.push({ state: "reconciled", worker: worker.name, plan, applied: null });
      continue;
    }
    let applied: ReconcileApplied;
    try {
      applied = await applyReconcilePlan({
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
    } catch {
      // Its own entry, and a different one from `unplanned`: this Worker's files have been opened for
      // writing. What landed of the plan is exactly what this run cannot say.
      results.push({ state: "unapplied", worker: worker.name, plan });
      continue;
    }
    results.push({ state: "reconciled", worker: worker.name, plan, applied });
  }
  return { workers: results, manifestFaults: faults };
}

/**
 * Whether any Worker in the run went unreconciled — the run's exit gate (#380).
 *
 * A guard that let `pithy upgrade` exit 0 around a Worker it could not read would be a weaker gate than
 * the throw it replaced, and this command runs headlessly in CI. So the failure still ends the run
 * non-zero; it just stops taking every other Worker's report with it.
 *
 * **A degraded contributor counts, and that is what merging `#371` into `#380` turned up.** `#380` wrote
 * this as `state !== "reconciled"`, which was complete on its own branch: a ledger that would not read
 * threw, the per-Worker guard caught it, and the Worker came back `unplanned`. `#371` then made every
 * contributor degrade instead of throw — the better design, and it left this reading `reconciled` for a
 * Worker whose ledger nobody could read, so the run exited 0 on a check that never happened.
 *
 * Neither branch was wrong; the composition was. So the gate asks the question it always meant to ask —
 * **was every Worker fully checked** — rather than the proxy for it that happened to be true before.
 * `partial` counts alongside `unavailable`: a short sum is not a whole one.
 */
export function upgradeIncomplete(run: UpgradeRun): boolean {
  return run.workers.some((result) => {
    if (result.state !== "reconciled") return true;
    return result.plan.ledger.state !== "read" || result.plan.entitlements.state !== "read";
  });
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

/**
 * What the plan's ledger says, in every state it can be in (#371).
 *
 * A database that could not be read gets its own line rather than being absorbed into a pending count of
 * zero. `upgrade --migrate` would run against exactly that database, so "nothing pending" about one
 * nobody could read is the sentence that sends an adopter to deploy.
 */
function ledgerLines(plan: ReconcilePlan): string[] {
  const ledger = plan.ledger;
  if (ledger.state === "unavailable") return [`Migrations: not checked for ${plan.env}. No database answered.`];
  const counted = ledger.state === "read" ? ledger : ledger.counted;
  const lines: string[] = [];
  if (counted.pending > 0) {
    const pending = count(counted.pending, "migration");
    lines.push(`${pending} pending. Run pithy upgrade --migrate, or pithy migrate --env ${plan.env}.`);
  }
  if (ledger.state === "partial") {
    const named = ledger.unreadable.map((entry) => `${entry.binding} (${entry.database})`).join(", ");
    lines.push(`Migrations: couldn't read ${named}. Any count above excludes them.`);
  }
  return lines;
}

/** The human-readable lines for one Worker's dry-run plan. */
function planLines(plan: ReconcilePlan): string[] {
  const lines: string[] = [];
  for (const cap of plan.perCapability) {
    const summary = parts(cap.missingBindings.length, cap.missingConfigKeys.length, "add");
    if (summary) lines.push(`${cap.name}: ${summary}`);
  }
  for (const name of plan.ejectedSkipped) lines.push(`${name}: ejected. Skipped.`);
  // The Worker's entry, in the same words the applied lines use one tense over. A Durable Object is one
  // binding written in two files, and the plan reported only the file that is config — so a project with
  // the binding and no export read as "Nothing to upgrade." while the deploy was refused (#428).
  const exports = [...new Set(plan.perCapability.flatMap((cap) => cap.missingEntryExports))];
  if (exports.length > 0) lines.push(`Worker entry: export ${exports.join(", ")}.`);
  if (plan.missingVersionMetadata) lines.push("version_metadata: add CF_VERSION_METADATA.");
  lines.push(...ledgerLines(plan));
  if (lines.length === 0) lines.push("Nothing to upgrade.");
  return lines;
}

/**
 * The human-readable lines for one Worker's applied upgrade.
 *
 * A skipped binding gets a line of its own, named, under the capability that needed it. **Counted, it
 * would be invisible** — and being invisible is exactly what #318 was: the count came from the plan, so
 * five bindings the writer declined were reported as added and the adopter's next command, `pithy
 * doctor`, contradicted this one about a file it had just written.
 */
function appliedLines(applied: ReconcileApplied, plan: ReconcilePlan): string[] {
  const lines: string[] = [];
  for (const cap of applied.perCapability) {
    const summary = parts(cap.addedBindings.length, cap.addedConfigKeys.length, "added");
    if (summary) lines.push(`${cap.name}: ${summary}`);
    for (const skipped of cap.skippedBindings) {
      lines.push(`${cap.name}: ${skipped.name} (${skipped.type}) not written for ${skipped.env} — ${skipped.reason}.`);
    }
  }
  for (const name of applied.ejectedSkipped) lines.push(`${name}: ejected. Skipped.`);
  // The Worker's entry, which is source in the adopter's repo rather than config. Named, because a file
  // this command edits without saying so is a `git diff` they have to reverse-engineer.
  if (applied.addedEntryExports.length > 0) {
    lines.push(`Worker entry: exported ${applied.addedEntryExports.join(", ")}.`);
  }
  if (applied.addedVersionMetadata) lines.push("version_metadata: added CF_VERSION_METADATA.");
  else if (plan.missingVersionMetadata) lines.push("version_metadata: names another binding. Left alone.");
  if (applied.migrated) {
    const total = applied.migrations.reduce((sum, run) => sum + run.results.length, 0);
    lines.push(total === 0 ? "Migrations up to date." : `Migrated ${count(total, "migration")}.`);
  } else {
    lines.push(...ledgerLines(plan));
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
  for (const result of run.workers) {
    lines.push(`${result.worker}:`);
    for (const line of workerLines(result)) lines.push(`  ${line}`);
  }
  return lines;
}

/**
 * One Worker's lines, in each of the three states it can be in (#380).
 *
 * Neither failure state prints "Nothing to upgrade." That sentence is a finding — the run looked and
 * found nothing — and it is the one thing an unread Worker must never say.
 */
function workerLines(result: UpgradeWorkerResult): string[] {
  if (result.state === "unplanned") {
    return [
      "Couldn't be planned. Its pithy.config.ts or wrangler.jsonc would not read.",
      "Nothing was written for it.",
    ];
  }
  if (result.state === "unapplied") {
    return [
      "Upgrade failed partway. Its wiring may hold part of the plan below.",
      `Check it, then re-run: pithy upgrade --worker ${result.worker} --env ${result.plan.env}.`,
      ...planLines(result.plan),
    ];
  }
  return result.applied ? appliedLines(result.applied, result.plan) : planLines(result.plan);
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

      // A Worker that could not be read establishes nothing, so the run does not exit 0 around it. Set
      // before either renderer, so the two paths cannot disagree about whether the run succeeded.
      if (upgradeIncomplete(run)) process.exitCode = 1;

      if (args.json) {
        // The state rides on every entry, so a consumer reads `state` before reaching for a plan — there
        // is no entry here whose absent fields could be read as empty ones.
        const workers = run.workers.map((result) =>
          result.state === "reconciled"
            ? { state: result.state, ...(result.applied ?? result.plan) }
            : result.state === "unapplied"
              ? { state: result.state, worker: result.worker, plan: result.plan }
              : { state: result.state, worker: result.worker },
        );
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
export const __test = { planLines, appliedLines, renderUpgrade, workerLines, parts, count };
