// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative, sep } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  type Caller,
  type Command,
  callerOf,
  pithyCommand,
  rerunCommand,
  viaPackageManager,
  workerDirOf,
} from "@pithy-sh/core/src/cli/command";
import type { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { operatorError } from "@pithy-sh/core/src/error/terminal";
import { defineCommand } from "citty";
import { z } from "zod";
import { availableManifests, ManifestFault } from "../capabilities/manifests";
import {
  applyReconcilePlan,
  buildReconcilePlan,
  declineRefusal,
  type ReadLedger,
  type ReconcileApplied,
  type ReconcilePlan,
  type RunMigrate,
} from "../capabilities/reconcile";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { withContract } from "../contract/commandContract";
import { type PackagesReport, runPackageStep } from "../kitPackages/apply";
import type { RegistryFetch } from "../kitPackages/registry";
import type { TemplateFinding, TemplateSection } from "../kitPackages/templates";
import { establishedPending } from "../migrations/pendingCount";
import { DRY_RUN_ARG, emptyPlan, type Plan, type PlanFile, PlanKey } from "../plan/plan";
import { agentsLine, InstructionsFile, syncAgentsBlock } from "../project/agentInstructions";
import { resolveWorkersFor } from "../project/composeFor";
import { loadProject, projectCloudflareAccount, requireProjectName, type WorkerConfig } from "../project/config";
import { envArg, requireEnvironment } from "../project/environment";
import type { InstallRunner } from "../project/packageManager";
import { pathExists } from "../project/scaffold";
import { workerDirName } from "../project/workerIdentity";
import { workerEntryPath, workerEnvironments } from "../project/wrangler";
import { EXIT } from "../terminal/exitClass";
import { NextKey, type NextStep, upgradeNext } from "../terminal/nextSteps";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy upgrade [--env] [--worker <name>] [--dry-run] [--migrate] [--packages [--latest]]` — reconcile every
 * Worker with the capability manifests installed in the project, and with `--packages`, move the project's
 * `@pithy-sh/*` dependencies first (#634).
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
  /**
   * That Worker's own `pithy.config.ts`, as `resolveWorkers` already returns it.
   *
   * Only `declinedBindings` is read from it here, and it is taken from the loaded config rather than
   * re-read, so the write this run makes and the report an adopter compares it against are built from
   * one read of one file. Optional because the seam predates it and a caller with no config to give is
   * a caller that declines nothing.
   */
  config?: WorkerConfig;
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
  /**
   * The caller's own `pithy upgrade` (#711), the one input a line naming this run again is built from, so it carries
   * every flag the caller gave — `--json` among them. The command passes its parsed arguments; absent, it is
   * {@link upgradeCallerOf} these options, for a caller with no command line behind it.
   */
  caller?: Caller<"upgrade">;
  /**
   * Worker-set resolver seam; defaults to {@link resolveWorkersFor} for `env`. The Workers are composed for
   * the environment the plan counts migrations in and `--migrate` applies them to — composed for none, a
   * config whose migrations differ by environment planned against the wrong set (#595).
   */
  resolveWorkers?: (options: { projectDir: string; worker?: string }) => Promise<UpgradeWorker[]>;
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /**
   * The project's `seed.productionEnvironments`. Read from the root config after the package step when omitted, so a
   * refusal naming a provision says one of them as a person's decision (#711).
   */
  productionEnvironments?: readonly string[];
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
  /** Test seam: substitute the manifest scan. Defaults to the real `node_modules/@pithy-sh` read. */
  readManifests?: (projectDir: string) => Promise<{ faults: ManifestFault[] }>;
  /**
   * `--packages`: move every `@pithy-sh/*` dependency to the newest version its range admits — or, with
   * `latest`, to `latest` — and reinstall, **before** anything reads a Worker's config. Absent, the run is
   * exactly what it was before #634: no registry request, no write, no spawn.
   */
  packages?: { latest: boolean };
  /** Test seam: the registry `--packages` reads. Defaults to the global `fetch`. */
  registryFetch?: RegistryFetch;
  /** Test seam: the package manager `--packages` runs. Defaults to the real `<pm> install`. */
  runInstall?: InstallRunner;
  /** Test seam: the `AGENTS.md` refresh. Defaults to {@link syncAgentsBlock}, which `pithy init` runs too. */
  refreshAgents?: (projectDir: string, options: { dryRun: boolean }) => Promise<InstructionsFile>;
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
      /**
       * This run, for this Worker, as the line names it to run again: its environment, its `--migrate`, and the
       * Worker by its `apps/` directory (#711) — never the deployed name `worker` carries.
       */
      again: Command;
    }
  | {
      /**
       * The plan was built and refused before the first write. **Distinct from `unapplied`, and the
       * distinction is the fact an adopter needs**: nothing was written, so there is no half-reconciled
       * wiring to inspect — only a declaration to fix.
       */
      state: "refused";
      /** The Worker's name. */
      worker: string;
      /** What the run would have done, reported so the adopter sees the cost of the refusal. */
      plan: ReconcilePlan;
      /** Why, as the operator's own problem and action lines rather than a swallowed throw. */
      refusal: ErrorPayload;
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
  /** What `--packages` did. Absent without the flag, so a run without it is the run it always was. */
  packages?: PackagesReport;
  /**
   * The Pithy block in `AGENTS.md` (#697). Absent only when `--packages` moved `@pithy-sh/cli` and the
   * reconcile was left to the new one — which writes its own block, not this binary's.
   */
  agents?: InstructionsFile;
  /** What a `--dry-run` would write, in the one plan shape every dry run shares (#697). Only under `dryRun`. */
  plan?: Plan;
}

/**
 * The flag combinations `upgrade` refuses, before anything is read.
 *
 * `--latest` without `--packages` would be a flag that does nothing, and a flag that does nothing is one an
 * adopter believes did something. `--packages` with `--worker` would be a promise the step cannot keep:
 * scaffolded projects are workspaces, one install moves every Worker's `node_modules`, and a hoisted copy is
 * shared by all of them.
 */
export function validateUpgradeFlags(flags: { packages: boolean; latest: boolean; worker?: string }): void {
  if (flags.latest && !flags.packages) {
    throw new ValidationError({ message: "--latest moves packages. Add --packages." });
  }
  if (flags.packages && flags.worker !== undefined) {
    throw new ValidationError({ message: "Packages move project-wide. Drop --worker." });
  }
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
 * The project's `seed.productionEnvironments`, or none where the root config cannot be read — the same reading, and
 * the same fallback, as {@link proposalProject}.
 */
async function projectProductionEnvironments(projectDir: string): Promise<readonly string[]> {
  try {
    return (await loadProject(projectDir)).seed?.productionEnvironments ?? [];
  } catch {
    return [];
  }
}

/**
 * Reconcile every Worker in scope, in discovery order. Each Worker gets its own plan, built from and (unless
 * `dryRun`) applied to its own `apps/<name>/` wiring — no Worker's drift can reach another's files.
 */
export async function runUpgrade(options: UpgradeRunOptions): Promise<UpgradeRun> {
  // **The packages move first**, before the manifest scan and before any `pithy.config.ts` is imported: the
  // reconcile below has to read the capabilities the project will run, not the ones it is leaving.
  let packages: PackagesReport | undefined;
  if (options.packages) {
    const step = await runPackageStep({
      projectDir: options.projectDir,
      latest: options.packages.latest,
      dryRun: options.dryRun,
      ...(options.registryFetch ? { fetch: options.registryFetch } : {}),
      ...(options.runInstall ? { runInstall: options.runInstall } : {}),
    });
    packages = step.report;
    // The running process is the old CLI. Reconciling with its manifests and its reconcile engine after
    // installing a new one would write the old answer into a project that has just asked for the new one.
    if (step.cliMoved !== null) return { workers: [], manifestFaults: [], packages };
    packages.reconciled = true;
  }
  const reconciled = await reconcileWorkers(options);
  // **After the reconcile, never before it.** Resolving the Workers is what establishes that this is a
  // project, so `pithy upgrade` in the wrong directory fails on that and leaves no `AGENTS.md` behind. Not
  // narrowed by `--worker`: the file is the project's, one merge is idempotent, and a refusal is reported
  // rather than failing the run — a hand-broken marker is the project's to fix, not a reconcile that failed.
  const agents = await (options.refreshAgents ?? syncAgentsBlock)(options.projectDir, { dryRun: options.dryRun });
  const run: UpgradeRun = { ...reconciled, ...(packages ? { packages } : {}), agents };
  return options.dryRun ? { ...run, plan: await planUpgrade(options.projectDir, run, options.migrate) } : run;
}

/** `"the top-level stanza"` for `dev`, `env.<name>` for the rest — where a missing binding is written. */
function stanzaName(env: string): string {
  return env === "dev" ? "the top-level stanza" : `env.${env}`;
}

/**
 * **A dry run's report, as the one plan every `--dry-run` shares (#697).** Read off what the run already
 * built — the package moves, the Pithy block, each reconciled Worker's plan — so it adds no second reading
 * of the project, only a second spelling of the first.
 *
 * Its edits are sentences, not diffs: the reconcile plan says which binding and which key, and the bytes
 * are written by the apply this dry run does not reach. What the run would refuse, and the migrations it
 * can count but not name, are notes. A Worker that could not be planned, or was refused, plans nothing.
 */
export async function planUpgrade(projectDir: string, run: UpgradeRun, migrate: boolean): Promise<Plan> {
  const plan = emptyPlan();
  const edits = new Map<string, PlanFile>();
  const edit = (path: string, change: string, action: PlanFile["action"] = "edit") => {
    const file = edits.get(path) ?? { path, action, changes: [] };
    file.changes.push(change);
    edits.set(path, file);
  };

  for (const move of run.packages?.moves ?? [])
    edit(move.manifest, `Moves ${move.name} from ${move.from} to ${move.to}.`);
  if (run.packages && run.packages.moves.length > 0) {
    // The package manager itself, as `runPackageStep` spawns it — not `execArgs`, which runs a package's bin.
    plan.notes.push(`Then runs ${run.packages.packageManager} install at the project root.`);
  }
  if (run.agents && (run.agents.state === "added" || run.agents.state === "updated")) {
    const exists = await pathExists(join(projectDir, run.agents.path));
    edit(
      run.agents.path,
      run.agents.state === "added" ? "Adds the Pithy block." : "Refreshes the Pithy block. Nothing outside it changes.",
      exists ? "edit" : "create",
    );
  }

  for (const result of run.workers) {
    if (result.state !== "reconciled") continue;
    const worker = result.plan;
    const dir = `apps/${worker.worker}`;
    for (const cap of worker.perCapability) {
      for (const binding of cap.missingBindings) {
        edit(
          `${dir}/wrangler.jsonc`,
          `Adds ${binding.name} (${binding.type}) to ${stanzaName(binding.env)}, for ${cap.name}.`,
        );
      }
      for (const key of cap.missingConfigKeys) {
        if (key.default === undefined && key.constant === undefined) {
          plan.notes.push(
            `${cap.name}: ${key.key} has no default. The upgrade refuses until ${dir}/pithy.config.ts sets it.`,
          );
        } else {
          edit(`${dir}/pithy.config.ts`, `Adds ${key.key} to ${cap.name}'s registration.`);
        }
      }
    }
    const exports = [...new Set(worker.perCapability.flatMap((cap) => cap.missingEntryExports))];
    if (exports.length > 0) {
      const entry = await workerEntryPath(join(projectDir, dir)).catch(() => null);
      const path = entry === null ? `${dir}/wrangler.jsonc` : relative(projectDir, entry).split(sep).join("/");
      edit(path, `Exports ${exports.join(", ")} from the Worker's entry.`);
    }
    if (worker.missingVersionMetadata) {
      edit(`${dir}/wrangler.jsonc`, "Adds the CF_VERSION_METADATA version_metadata binding.");
    }
    const migrations = count(establishedPending(worker.ledger) ?? 0, "migration");
    if (migrations !== null) {
      plan.notes.push(
        migrate
          ? `${worker.worker}: then applies ${migrations} pending on ${worker.env}.`
          : `${worker.worker}: ${migrations} pending on ${worker.env}. ${pithyCommand("upgrade", { flags: { "--worker": workerDirOf({ dir: worker.worker }), "--env": worker.env, "--migrate": true } })} applies them.`,
      );
    }
  }
  plan.files = [...edits.values()];
  return plan;
}

/** The reconcile, every Worker in scope — the whole of `pithy upgrade` before #634. */
async function reconcileWorkers(options: UpgradeRunOptions): Promise<UpgradeRun> {
  const resolve = options.resolveWorkers ?? ((scope) => resolveWorkersFor(options.env, scope));
  const scan = options.readManifests ?? availableManifests;
  const { faults } = await scan(options.projectDir);
  const workers = await resolve({
    projectDir: options.projectDir,
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
  });
  const project = options.dryRun ? undefined : await proposalProject(options.projectDir);
  const productionEnvironments =
    options.productionEnvironments ?? (await projectProductionEnvironments(options.projectDir));

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
        // The whole config, not just `declinedBindings` — the reader also refuses a key that is nearly
        // that one, and it can only see such a key if it is handed what the adopter actually wrote.
        ...(worker.config ? { workerConfig: worker.config } : {}),
        ...(options.readLedger ? { readLedger: options.readLedger } : {}),
      });
    } catch {
      results.push({ state: "unplanned", worker: worker.name });
      continue;
    }
    // **Before the dry-run branch, not after it.** A dry run's whole job is to predict the write, and
    // the refusal is the thing that stops it — so a `--dry-run` that printed "Nothing to upgrade." and
    // exited 0 where the real run exits 1 is the one report that must never disagree with the run it
    // describes. Nothing is written on either path, so refusing costs the dry run nothing.
    // Every environment the Worker provisions for: an undeclinable binding is created by a provision, and one
    // that acts on a single environment is named once for each (#711).
    const refusal = declineRefusal(plan, await workerEnvironments(worker.dir), productionEnvironments);
    if (refusal) {
      results.push({ state: "refused", worker: worker.name, plan, refusal: refusal.payload });
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
        productionEnvironments,
      });
    } catch {
      // Its own entry, and a different one from `unplanned`: this Worker's files have been opened for
      // writing. What landed of the plan is exactly what this run cannot say.
      // The caller's own run, from its context, narrowed to this Worker (#711).
      const again = rerunCommand(options.caller ?? upgradeCallerOf(options), {
        flags: { "--worker": workerDirName(worker), "--packages": undefined, "--latest": undefined },
      });
      results.push({ state: "unapplied", worker: worker.name, plan, again });
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

/**
 * Whether the `--packages` step failed: the registry did not answer, an install landed something other than
 * what was asked for, or a template target would not read. **A held entry is not a failure** — the run did
 * what it was asked and said what it would not do.
 */
function packagesIncomplete(report: PackagesReport | undefined): boolean {
  if (!report) return false;
  return (
    report.state === "unavailable" ||
    report.mismatches.length > 0 ||
    report.templates.some((section) => section.state === "unavailable")
  );
}

/** The run's exit gate: a Worker not fully reconciled, or a package step that did not complete. */
export function upgradeFailed(run: UpgradeRun): boolean {
  return upgradeIncomplete(run) || packagesIncomplete(run.packages);
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
    const worker = workerDirOf({ dir: plan.worker });
    const upgrade = pithyCommand("upgrade", { flags: { "--worker": worker, "--env": plan.env, "--migrate": true } });
    const migrate = pithyCommand("migrate", { flags: { "--worker": worker, "--env": plan.env } });
    lines.push(`${pending} pending. Run ${upgrade}, or ${migrate}.`);
  }
  if (ledger.state === "partial") {
    const named = ledger.unreadable.map((entry) => `${entry.binding} (${entry.database})`).join(", ");
    lines.push(`Migrations: couldn't read ${named}. Any count above excludes them.`);
  }
  return lines;
}

/**
 * The lines a declined binding earns in either tense.
 *
 * Only the two states an upgrade acts on quietly: an honored decline, which is a binding this run
 * deliberately did not write, and a stale one, which names nothing and is ignored. The two refusals
 * never reach a renderer — `applyReconcilePlan` throws on them before it writes, so they arrive as an
 * error with an action line rather than as a report of work done.
 *
 * Appended after `Nothing to upgrade.` rather than before it, and deliberately: a run that wrote
 * nothing *did* write nothing, and a decline is why part of that is true rather than a contradiction
 * of it.
 */
function declineLines(plan: ReconcilePlan): string[] {
  if (plan.declinedBindings.state !== "read") return [];
  return plan.declinedBindings.declines.flatMap((decline) => {
    if (decline.state === "honored") {
      return [`${decline.capability}: ${decline.name} (${decline.type}) declined in pithy.config.ts. Not written.`];
    }
    if (decline.state === "unrecognized") {
      return [`declinedBindings: ${decline.name} is declined, and nothing here declares it. Ignored.`];
    }
    return [];
  });
}

/** What a Worker with no drift says, rather than saying nothing and reading as skipped. */
const NOTHING_TO_UPGRADE = "Nothing to upgrade.";

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
  if (lines.length === 0) lines.push(NOTHING_TO_UPGRADE);
  lines.push(...declineLines(plan));
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
  if (lines.length === 0) lines.push(NOTHING_TO_UPGRADE);
  lines.push(...declineLines(plan));
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
  if (result.state === "refused") {
    // The plan is printed under it deliberately: the refusal says what to fix, and the plan says what
    // the Worker gives up until it is fixed. Neither alone is the whole answer.
    //
    // Except when the plan's answer is nothing. `planLines` fills an empty plan with `Nothing to
    // upgrade.` so a Worker with no drift is never silent — but under a refusal that sentence reads as
    // a contradiction of the two lines above it, and the honest thing to print is neither.
    const pending = planLines(result.plan);
    const gives = pending.length === 1 && pending[0] === NOTHING_TO_UPGRADE ? [] : pending;
    return [result.refusal.message, ...(result.refusal.action ? [result.refusal.action] : []), ...gives];
  }
  if (result.state === "unapplied") {
    return [
      "Upgrade failed partway. Its wiring may hold part of the plan below.",
      `Check it, then re-run: ${result.again}.`,
      ...planLines(result.plan),
    ];
  }
  return result.applied ? appliedLines(result.applied, result.plan) : planLines(result.plan);
}

/** Group equal lines — one package moved the same way in two manifests is one line naming both. */
function grouped<T>(entries: readonly T[], key: (entry: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return [...groups];
}

const HELD_REASON = {
  breaking: "Crosses a breaking boundary.",
  "outside-range": "Outside the declared range.",
} as const;
const LEFT_ALONE_REASON = {
  "not-a-registry-range": "Not a registry range.",
  linked: "Linked from a checkout.",
} as const;

/** The `Packages:` block. */
function packageLines(report: PackagesReport, dryRun: boolean): string[] {
  if (report.state === "unavailable") {
    return [
      "Packages: not checked. The registry did not answer. Nothing moved.",
      ...leftAloneLines(report).map((line) => `  ${line}`),
    ];
  }
  const lines: string[] = [];
  for (const [, moves] of grouped(report.moves, (move) => `${move.name}\0${move.from}\0${move.to}`)) {
    const [first] = moves;
    if (!first) continue;
    lines.push(`${first.name}  ${first.from} → ${first.to}  (${moves.map((move) => move.manifest).join(", ")})`);
  }
  for (const [, held] of grouped(report.held, (entry) => `${entry.name}\0${entry.latest}\0${entry.reason}`)) {
    const [first] = held;
    if (!first) continue;
    lines.push(`${first.name}  ${first.latest} held. ${HELD_REASON[first.reason]} Run ${first.command}.`);
  }
  lines.push(...leftAloneLines(report));
  for (const miss of report.mismatches) {
    lines.push(
      `${miss.name}  expected ${miss.expected} in ${miss.manifest}. Installed: ${miss.installed ?? "nothing"}.`,
    );
  }
  if (lines.length === 0) return ["Packages: nothing to move."];
  if (dryRun && report.moves.length > 0) {
    lines.push("Reconciled against the current install. The moves above are not installed.");
  }
  return ["Packages:", ...lines.map((line) => `  ${line}`)];
}

/** One line per declaration left alone, grouped the way moves are. */
function leftAloneLines(report: PackagesReport): string[] {
  return grouped(report.leftAlone, (entry) => `${entry.name}\0${entry.spec}\0${entry.reason}`).flatMap(([, group]) => {
    const [first] = group;
    return first ? [`${first.name}  ${first.spec} left alone. ${LEFT_ALONE_REASON[first.reason]}`] : [];
  });
}

/** What one template finding asks of the adopter. */
function findingLine(finding: TemplateFinding, to: string): string {
  if (finding.change === "added") return `${finding.path}  new in ${to}. Not in this Worker.`;
  if (finding.change === "removed") return `${finding.path}  gone from ${to}. Still in this Worker.`;
  if (finding.copy === "untouched")
    return `${finding.path}  changed upstream. The copy is ${finding.from}'s, untouched.`;
  return `${finding.path}  changed upstream. The copy is edited. Merge by hand.`;
}

/** The `Templates` block, one heading per section, the provenance line under the first. */
function templateLines(report: PackagesReport): string[] {
  if (report.state === "unavailable") return [];
  if (report.templates.length === 0) return ["Templates: not checked. No template-bearing package moves."];
  const lines: string[] = [];
  let noted = false;
  for (const section of report.templates) {
    lines.push(...sectionLines(section, noted));
    noted ||= section.state === "checked";
  }
  return lines;
}

function sectionLines(section: TemplateSection, noted: boolean): string[] {
  const to = section.to ?? "an unresolved version";
  const from = section.from.length > 0 ? `${section.from.join(", ")} → ` : "→ ";
  const heading = `Templates (${section.package} ${from}${to}${section.applied ? "" : ", held"})`;
  if (section.state === "unchecked") return [`${heading}: not checked. No installed copy to compare from.`];
  if (section.state === "unavailable") return [`${heading}: not checked. The target templates would not read.`];
  const lines = [`${heading}:`];
  if (!noted) {
    lines.push(
      `  Templates come from the CLI's ${section.package}. The copies are the project's; nothing here rewrites them.`,
    );
  }
  if (section.files.length === 0) lines.push("  No copied template differs.");
  for (const [worker, files] of grouped(section.files, (finding) => finding.worker)) {
    lines.push(`  ${worker}:`, ...files.map((finding) => `    ${findingLine(finding, to)}`));
  }
  return lines;
}

/**
 * **`pithy upgrade` as a run with no command line behind it names itself (#711)** — a test, or a caller that drives
 * {@link runUpgrade} directly: its environment, its Worker, `--migrate` and a dry run. The command passes its own
 * parsed arguments instead, so every flag the caller gave carries.
 */
export function upgradeCallerOf(options: {
  readonly env: string;
  readonly migrate: boolean;
  readonly worker?: string | undefined;
  readonly dryRun?: boolean | undefined;
}): Caller<"upgrade"> {
  return callerOf("upgrade", {
    env: options.env,
    migrate: options.migrate,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.dryRun === true ? { "dry-run": true } : {}),
  });
}

/**
 * The project's own CLI's `upgrade`, through its package manager — a bare `pithy` may be the old, global one — and
 * the caller's own run (#711): its `--env`, `--worker` and `--migrate` each change what the reconcile acts on.
 * Less `--packages` and `--latest`, which did their work in this run, and would move the packages again.
 */
function reconcileCommand(packages: PackagesReport, caller: Caller<"upgrade">): string {
  return viaPackageManager(
    packages.packageManager,
    rerunCommand(caller, { flags: { "--packages": undefined, "--latest": undefined } }),
  );
}

/**
 * The whole text report, closing line included. The package blocks sit above the Workers, because they
 * happened first and the reconcile read their result.
 */
export function upgradeText(
  run: UpgradeRun,
  dryRun: boolean,
  caller: Caller<"upgrade"> = upgradeCallerOf({ env: "dev", migrate: false }),
): string[] {
  const lines: string[] = [];
  if (run.packages) lines.push(...packageLines(run.packages, dryRun), ...templateLines(run.packages));
  // Project-wide, so above the Workers like the manifest faults. Silent when the block was already current.
  const agents = run.agents ? agentsLine(run.agents, dryRun) : null;
  if (agents !== null) lines.push(agents);
  lines.push(...renderUpgrade(run));
  const cli = run.packages?.moves.find((move) => move.name === "@pithy-sh/cli");
  if (run.packages && !run.packages.reconciled && cli) {
    // The project's own CLI, through its package manager: a bare `pithy` may be a global one, which is the
    // old CLI this line exists to get past.
    lines.push(
      `@pithy-sh/cli moved to ${cli.target}. Run ${reconcileCommand(run.packages, caller)} to reconcile with it.`,
    );
  }
  lines.push(dryRun ? "Dry run. Nothing written." : formatDone());
  return lines;
}

/**
 * What this run left required, as `next` (#697): the project's own CLI, when `--packages` moved it and the
 * reconcile was left to the new one, or `pithy migrate` for the migrations it counted and did not run.
 *
 * **The count is only ever whole.** A Worker that is not `reconciled`, or whose ledger read in part or not at
 * all, fails the run ({@link upgradeIncomplete}), and a failed run carries no `next` — so every count summed
 * here read whole, and a short count never reaches an agent as a step. The count is `establishedPending`'s.
 */
export function upgradeFollowUp(
  run: UpgradeRun,
  options: { env: string; dryRun: boolean; migrate: boolean; caller?: Caller<"upgrade"> },
): NextStep[] | undefined {
  let pending = 0;
  for (const result of run.workers) {
    if (result.state === "reconciled") pending += establishedPending(result.plan.ledger) ?? 0;
  }
  const packages = run.packages;
  const deferred =
    packages !== undefined && !packages.reconciled && packages.moves.some((move) => move.name === "@pithy-sh/cli");
  const { caller = upgradeCallerOf(options), ...facts } = options;
  return upgradeNext({
    ...facts,
    failed: upgradeFailed(run),
    pending,
    ...(deferred ? { reconcileWith: reconcileCommand(packages, caller) } : {}),
  });
}

/**
 * The `--json` line. `packages` rides only when `--packages` was passed: `formatJsonLine` drops an
 * `undefined`, so a run without the flag carries no `packages` key at all. `agents` rides on every run but
 * the one whose `--packages` moved `@pithy-sh/cli`, for the same reason, and so does `next`.
 */
export function upgradeJsonLine(
  run: UpgradeRun,
  env: string,
  dryRun: boolean,
  migrate = false,
  caller: Caller<"upgrade"> = upgradeCallerOf({ env, migrate }),
): string {
  // The state rides on every entry, so a consumer reads `state` before reaching for a plan — there
  // is no entry here whose absent fields could be read as empty ones.
  const workers = run.workers.map((result) =>
    result.state === "reconciled"
      ? { state: result.state, ...(result.applied ?? result.plan) }
      : result.state === "unapplied"
        ? { state: result.state, worker: result.worker, plan: result.plan }
        : result.state === "refused"
          ? // `operatorError` rather than the raw payload: this line is the operator's, so it
            // carries `action` — the field `clientError` strips and the one naming the entry to
            // remove. A consumer reading this is driving the CLI, not receiving a response.
            { state: result.state, worker: result.worker, plan: result.plan, ...operatorError(result.refusal) }
          : { state: result.state, worker: result.worker },
  );
  const next = upgradeFollowUp(run, { env, dryRun, migrate, caller });
  return formatJsonLine({
    command: "upgrade",
    env,
    dryRun,
    workers,
    manifestFaults: run.manifestFaults,
    packages: run.packages,
    agents: run.agents,
    plan: run.plan,
    next,
  });
}

/** `pithy upgrade --json`. `docs/commands/upgrade.md`. */
const UpgradePayload = z
  .object({
    command: z.literal("upgrade").describe('`"upgrade"`.'),
    env: z.string().describe("The environment the pending-migration count was taken against."),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. Nothing was written when it is `true`."),
    workers: z
      .array(
        z
          .looseObject({
            state: z
              .enum(["reconciled", "unplanned", "unapplied", "refused"])
              .describe(
                "`reconciled` — planned, and applied unless a dry run. `unplanned` — the plan could not be built. `unapplied` — built and not applied. `refused` — applying it was refused, with the error's fields beside it.",
              ),
            worker: z.string().describe("The Worker's name."),
          })
          .describe("One Worker's reconcile: its plan or what it applied, and a refusal's error fields when refused."),
      )
      .describe("One entry per Worker, in fan-out order."),
    manifestFaults: z.array(ManifestFault).describe("Installed packages whose manifest is present and unusable."),
    packages: z
      .looseObject({})
      .optional()
      .describe("What `--packages` moved and reinstalled. Present only when `--packages` was passed."),
    agents: InstructionsFile.optional().describe(
      "`AGENTS.md`, and what happened to the Pithy block in it. Absent only when `--packages` moved `@pithy-sh/cli` and the reconcile was left to the new one.",
    ),
    plan: PlanKey,
    next: NextKey,
  })
  .describe("What `pithy upgrade` reconciled.");

export default withContract(
  defineCommand({
    meta: {
      name: "upgrade",
      description: "Reconcile each worker's installed capabilities with its pithy.config.ts and wrangler.jsonc",
    },
    args: {
      env: envArg("Target environment (drives the pending-migration count)"),
      worker: { type: "string", description: "Upgrade only this worker (default: every worker under apps/)" },
      "dry-run": DRY_RUN_ARG,
      migrate: { type: "boolean", default: false, description: "Run pending migrations after reconciling" },
      packages: {
        type: "boolean",
        default: false,
        description: "Move each @pithy-sh/* dependency to the newest version its range admits, and reinstall",
      },
      latest: { type: "boolean", default: false, description: "With --packages: move held packages to latest" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        validateUpgradeFlags({
          packages: args.packages,
          latest: args.latest,
          ...(args.worker ? { worker: args.worker } : {}),
        });
        const dryRun = args["dry-run"];
        const projectDir = process.cwd();
        // The caller's own run, the one input every line naming it again is built from (#711).
        const caller = callerOf("upgrade", args);
        const run = await runUpgrade({
          projectDir,
          caller,
          env,
          account: await projectCloudflareAccount(projectDir),
          ...(args.worker ? { worker: args.worker } : {}),
          dryRun,
          migrate: args.migrate,
          ...(args.packages ? { packages: { latest: args.latest } } : {}),
        });

        // A Worker that could not be read establishes nothing, so the run does not exit 0 around it. Set
        // before either renderer, so the two paths cannot disagree about whether the run succeeded.
        if (upgradeFailed(run)) process.exitCode = EXIT.failed;

        if (args.json) {
          process.stdout.write(`${upgradeJsonLine(run, env, dryRun, args.migrate, caller)}\n`);
          return;
        }

        for (const line of upgradeText(run, dryRun, caller)) process.stdout.write(`${line}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: UpgradePayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
    flagGroups: [
      { kind: "requires", flag: "--latest", needs: ["--packages"], any: false, rule: "--latest needs --packages." },
      {
        kind: "atMostOne",
        flags: ["--packages", "--worker"],
        rule: "--packages moves the whole project, so it takes no --worker.",
      },
    ],
  },
);

// Exposed for the command test to exercise the render helpers directly (run() stays thin and untested).
export const __test = { planLines, appliedLines, renderUpgrade, workerLines, parts, count };
