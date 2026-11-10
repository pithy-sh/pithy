// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { type Command, commandName, pithyCommand, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { messageOf, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { exportsName, reexportsAll } from "../capabilities/configImports";
import { isSourceEnvironment } from "../provision/featureConfig";
import { withFix } from "../terminal/exitClass";
import {
  type AdopterHostedJobs,
  type AppWorkflowPlan,
  adopterHostedJobs,
  appOwnedWorkflows,
  planAppWorkflows,
  type WorkflowConfig,
  type WorkflowStanza,
} from "./appWorkflows";
import { composeFor } from "./composeFor";
import { loadProject, loadProjectEnvironments, requireProjectName } from "./config";
import { readOptionalFile } from "./readOptionalFile";
import { workerDirName } from "./workerIdentity";
import { discoverWorkers } from "./workers";
import { readOptionalWranglerConfig, workerEntryPath } from "./wrangler";

/**
 * **What the app capability declares is what the environment's stanza binds.**
 *
 * `reconcileAppWorkflows` derives the `workflows` table and `triggers.crons` from the `app` capability's `workflows`
 * map and writes them into `wrangler.jsonc`, and `pithy worker sync` is its only caller. This file reads the two
 * halves back, for `pithy doctor` and the deploy gate, because a job declared and never synced deploys with no
 * `workflows` entry and no `triggers.crons`:
 *
 * - **The cron never fires.** No request fails, no log line appears, no probe goes red. This is the failure this
 *   reader exists for.
 * - **`c.var.workflows.trigger("board/digest", …)` cannot reach a binding wrangler never wrote.** Loud: `createBackend`
 *   derives a `workflow` binding spec from every registered job, so a non-`optional` one that is absent fails
 *   `validateBindings` on the Worker's first request.
 * - **A binding that carries another environment's name** starts instances of a Workflow deployed for somewhere else.
 *
 * ## The question is asked once, of the whole table
 *
 * The declaration is reduced to the table it implies through {@link planAppWorkflows}, the function the writer plans
 * with, and the stanza's app-owned table is read back through {@link appOwnedWorkflows}, the rule the writer replaces
 * by. The two are compared whole, so a missing binding, a stale binding, a stale cron and a wrong name are one fault
 * with one remedy, and so is any other way the two can differ. Order is not part of it: Cloudflare reads a table.
 *
 * ## What it does not claim
 *
 * A Worker whose `pithy.config.ts` will not import makes no claim: "this declares no jobs" is a negative finding, and
 * a config nobody could open may have declared some. A Worker with no `app` capability makes none either, since
 * `pithy worker sync` writes nothing for it.
 *
 * Files only, offline, no account call, so this can gate a deploy without a round trip.
 */

/** Which of the two ways a declaration and a stanza fail to be the same thing. Two remedies. */
export type WorkflowFault =
  /** The stanza does not bind what the app declares — in either direction. `pithy worker sync` settles it. */
  | "unsynced-stanza"
  /** The declaration cannot be reduced to a stanza at all, so no command could write one. */
  | "unwritable-declaration";

/** One Worker-and-environment whose declaration and stanza are not the same table. */
export interface WorkflowDrift {
  /** The Worker's `apps/<name>` directory. */
  worker: WorkerDir;
  /** The environment. */
  env: string;
  /** Which fault this is. */
  fault: WorkflowFault;
  /** What the app capability declares for this environment. Empty on `unwritable-declaration`. */
  declared: AppWorkflowPlan;
  /** What this environment's stanza binds for this Worker's own script. Evidence, never a secret. */
  bound: AppWorkflowPlan;
  /**
   * On `unwritable-declaration` alone: why the declaration could not be reduced to a stanza.
   *
   * Carried rather than re-derived, because the refusal is core's and its sentence names the field —
   * a job with no `className` has no class for wrangler to instantiate, and only `hostWorkflowsFor`
   * knows that. Restating it here would be a second, staler copy of the same rule.
   */
  reason?: string;
}

/** What `doctor` learned. Listed positively, so an inconclusive read never gates CI. */
export type WorkflowsState =
  /** Every declared environment binds exactly what its Worker's app capability declares. */
  | "ok"
  /** The root config would not load or names no project, so no Workflow name could be composed. */
  | "could-not-check"
  /** A declaration and a stanza disagree. Established from local files alone. */
  | "drifted";

/** What `doctor` reports about this project's app-declared Workflows. */
export interface WorkflowsCheck {
  state: WorkflowsState;
  drift: WorkflowDrift[];
}

/** The empty table — what an environment declares when its job cannot be named, and what a bare stanza binds. */
const NOTHING: AppWorkflowPlan = { workflows: [], crons: [] };

/**
 * One table, in a form two of them can be compared by.
 *
 * Every field of every entry, because presence is not the question: a binding called `DIGEST` pointing
 * at `replay-staging-board-digest` in `env.prod` is bound, and bound to the wrong Workflow. Sorted,
 * because the array's order is not part of the invariant.
 */
function canonical(plan: AppWorkflowPlan): string {
  return JSON.stringify({
    workflows: plan.workflows.map((entry) => [entry.binding, entry.name, entry.class_name]).sort(),
    crons: [...plan.crons].sort(),
  });
}

/**
 * What one environment's stanza binds for this Worker's own script — the right-hand side of the comparison.
 *
 * Without what the adopter wrote for a library's jobs they host: an entry under one of those bindings, and
 * a cron that is one of those schedules and not also the app's. Both are theirs, and neither is the app's to declare.
 */
function boundBy(
  stanza: WorkflowStanza | undefined,
  kept: AdopterHostedJobs,
  declared: AppWorkflowPlan,
): AppWorkflowPlan {
  return {
    workflows: appOwnedWorkflows(stanza, kept),
    crons: (stanza?.triggers?.crons ?? []).filter((cron) => !kept.schedules.has(cron) || declared.crons.includes(cron)),
  };
}

/**
 * One Worker's app capability, or `undefined` when there is no declaration to compare against.
 *
 * The two cases collapse deliberately. A config that will not import declares nothing *knowable*, and a
 * Worker with no `app` block declares nothing *at all* — and in both, the honest output is silence
 * rather than a fault naming a command that would report, correctly and uselessly, that it wrote nothing.
 *
 * **Composed for the environment it is compared in.** An app may declare a job or a schedule for one environment
 * alone, so each stanza is compared with its own environment's declaration, never with whichever environment the
 * module cache holds.
 */
async function workerApp(
  workerDir: string,
  environment: string,
): Promise<{ app: Capability; capabilities: readonly Capability[] } | undefined> {
  try {
    const config = await composeFor(environment, async (load) => load(workerDir));
    return config.app ? { app: config.app, capabilities: config.capabilities ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

/** What one Worker's app capability declares for one environment, or why no stanza can be written for it. */
type WorkflowDeclaration =
  | { state: "declared"; plan: AppWorkflowPlan; capabilities: readonly Capability[] }
  | { state: "unwritable"; reason: string };

/**
 * One Worker's declaration for one environment, composed for that environment — the resolution
 * {@link workflowDrift} compares stanzas against and {@link workflowExports} reads classes from.
 * `undefined` when there is no declaration to read.
 *
 * A job `planAppWorkflows` cannot name is returned as `unwritable` rather than thrown, so one bad job reports
 * itself instead of taking every other Worker's answer down with it.
 */
async function declaredWorkflows(
  workerDir: string,
  project: string,
  env: string,
): Promise<WorkflowDeclaration | undefined> {
  const composed = await workerApp(workerDir, env);
  if (!composed) return undefined;
  try {
    return {
      state: "declared",
      plan: planAppWorkflows(composed.app, { project, env }),
      capabilities: composed.capabilities,
    };
  } catch (error) {
    return { state: "unwritable", reason: messageOf(error) };
  }
}

/** Whether a Worker's main module exports every Workflow class its app declares. */
export type WorkflowExports =
  /** Every declared class is exported, or none is declared. */
  | { state: "exported" }
  /** main was read, and `missing` holds each declared class it does not export, in declaration order. */
  | { state: "missing"; main: string; missing: string[] }
  /** main could not be read, or reads in a way that cannot establish a class is absent. `reason` says which. */
  | { state: "unreadable"; reason: string };

/**
 * The declared Workflow classes the Worker's main module does not export.
 *
 * Cloudflare resolves an app Workflow's `class_name` against the module `main` names, so a class missing there is
 * a deploy wrangler refuses. The classes come from {@link declaredWorkflows}, each environment composed for
 * itself, which is the same declaration `checkWorkflows` and `assertWorkflowsBound` compare stanzas against.
 *
 * Absence is only claimed of a module that was read: no `main`, a file that will not open, and an
 * `export * from` the scanner cannot see through are each `unreadable`, never a list of every class.
 */
export async function workflowExports(
  workerDir: string,
  project: string,
  environments: readonly string[],
): Promise<WorkflowExports> {
  const classes = new Set<string>();
  for (const env of environments) {
    const declaration = await declaredWorkflows(workerDir, project, env);
    if (declaration?.state !== "declared") continue;
    for (const entry of declaration.plan.workflows) classes.add(entry.class_name);
  }
  if (classes.size === 0) return { state: "exported" };

  const entry = await workerEntryPath(workerDir).catch(() => null);
  if (entry === null) return { state: "unreadable", reason: "wrangler.jsonc names no main module" };
  const shown = relative(workerDir, entry).split("\\").join("/");
  const source = await readOptionalFile(entry).catch(() => null);
  if (source === null) return { state: "unreadable", reason: `${shown} could not be read` };

  const missing = [...classes].filter((className) => !exportsName(source, className));
  if (missing.length > 0 && reexportsAll(source)) {
    return { state: "unreadable", reason: `${shown} re-exports with export *, which this check does not follow` };
  }
  return missing.length === 0 ? { state: "exported" } : { state: "missing", main: shown, missing };
}

/**
 * Every Worker-and-environment in `environments` whose declaration and stanza are not the same table, in
 * worker then environment order.
 *
 * `project` is passed in and never guessed: a Workflow name is account-scoped and leads with the project,
 * so a guessed one would compare the stanza against a name belonging to somebody else's project. It is
 * `requireProjectName`'s answer, exactly as `reconcileAppWorkflows` takes it.
 */
export async function workflowDrift(
  projectDir: string,
  project: string,
  environments: readonly string[],
): Promise<WorkflowDrift[]> {
  const drift: WorkflowDrift[] = [];
  for (const target of await discoverWorkers(projectDir)) {
    if (target.hasWrangler === false) continue;
    const config = (await readOptionalWranglerConfig(target.dir).catch(() => null)) as WorkflowConfig | null;
    if (!config) continue;
    const worker = workerDirName(target);
    for (const env of environments) {
      const declaration = await declaredWorkflows(target.dir, project, env);
      if (!declaration) continue;
      if (declaration.state === "unwritable") {
        drift.push({
          worker,
          env,
          fault: "unwritable-declaration",
          declared: NOTHING,
          bound: NOTHING,
          reason: declaration.reason,
        });
        continue;
      }
      const declared = declaration.plan;
      const bound = boundBy(config.env?.[env], adopterHostedJobs(declaration.capabilities), declared);
      if (canonical(declared) !== canonical(bound)) {
        drift.push({ worker, env, fault: "unsynced-stanza", declared, bound });
      }
    }
  }
  return drift;
}

/** One table as a sentence fragment: what is bound, or `nothing`. Both sides of every report read this way. */
function summarize(plan: AppWorkflowPlan): string {
  const parts = [
    ...plan.workflows.map((entry) => `${entry.binding} → ${entry.name}`),
    ...plan.crons.map((cron) => `cron ${cron}`),
  ];
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/**
 * One drift, as the sentence that fits it — and the sentence is the comparison, both sides of it.
 *
 * Naming only the half that is missing would leave the reader opening two files to learn what was
 * compared against what, and it would have nothing to say at all about the direction where the stanza
 * carries more than the declaration.
 */
export function describeWorkflowDrift(drift: WorkflowDrift): string {
  // The command the `fix` carries, from the same builder, or none where no command writes it.
  const sync = workflowSync(drift);
  if (sync === null) {
    return `${drift.worker} declares a job nothing can bind in ${drift.env}: ${drift.reason} Fix workflows in the Worker's pithy.config.ts — ${commandName("worker sync")} would refuse it the same way.`;
  }
  return `${drift.worker} declares ${summarize(drift.declared)} for ${drift.env}, and env.${drift.env} binds ${summarize(drift.bound)}. Run ${sync} to write the declaration into wrangler.jsonc.`;
}

/**
 * The command that rights `drift`, or `null` when none can — `pithy doctor --json`'s `fix`, on the branch
 * {@link describeWorkflowDrift} takes: `pithy worker sync` writes an unsynced stanza, and a declaration it
 * cannot reduce is the config's to fix.
 */
export function workflowDriftFix(drift: WorkflowDrift): Command | null {
  return workflowSync(drift);
}

/** {@link workflowDriftFix}'s command, for doctor's `fix` and the deploy refusal's alike, so the two are one. */
function workflowSync(drift: WorkflowDrift): Command | null {
  if (drift.fault === "unwritable-declaration") return null;
  return pithyCommand("worker sync", { flags: { "--worker": drift.worker, "--env": drift.env } });
}

/** The throw-site context behind each fault — why this one is worth a refusal. */
function workflowDetail(fault: WorkflowFault): string {
  return fault === "unwritable-declaration"
    ? "hostWorkflowsFor refuses a job it cannot name, so there is no stanza any command could write for this environment."
    : `A declared Workflow and the binding that runs it are two halves of one fact in two files, and only ${commandName("worker sync")} writes the second — so a cron nothing bound never fires, and nothing anywhere reports it.`;
}

/**
 * Refuse to deploy into an environment that does not bind what its Workers declare.
 *
 * The same moment, and the same reasoning, as `assertOriginsDeclared` beside it: deploy already knows the
 * environment and already has the config, and this is the last point at which the mistake is still
 * hypothetical. It costs no account call.
 *
 * **A feature environment is exempt, and by the same rule.** Its stanza is a generated build artifact
 * under `.wrangler/`, written by provisioning from the tracked file rather than by `pithy worker sync` —
 * so a fault here would refuse every feature deploy and name a command that does not write that file.
 * `isSourceEnvironment` is the predicate the config-path resolver uses, so the two cannot disagree about
 * which environments keep their config in source.
 *
 * A project whose root config will not load or names nothing establishes nothing, and a deploy is not
 * refused on nothing — the same evidence standard every gate here is held to.
 */
export async function assertWorkflowsBound(projectDir: string, env: string): Promise<void> {
  if (!isSourceEnvironment(env)) return;
  const project = await loadProject(projectDir)
    .then(requireProjectName)
    .catch(() => null);
  if (project === null) return;
  const drift = await workflowDrift(projectDir, project, [env]);
  if (drift.length === 0) return;
  const first = drift[0] as WorkflowDrift;
  // As `assertOriginsDeclared` beside it: a precondition, exit 3, with doctor's own `fix` when one command
  // rights all of it.
  const refusal = new PreconditionFailedError({
    message: `${env} does not bind what it declares: ${drift.map((entry) => entry.worker).join(", ")}.`,
    action: drift.map(describeWorkflowDrift).join(" "),
    detail: workflowDetail(first.fault),
  });
  const remedy = drift.length === 1 ? workflowSync(first) : null;
  throw remedy === null ? refusal : withFix(refusal, remedy);
}

/**
 * The same question asked of every environment the project declares, for `pithy doctor`.
 *
 * `could-not-check` when the root config will not load or names no project: a Workflow name leads with
 * the project, so without one there is nothing to compare a stanza against — and the `Project:` block
 * already owns saying that a config would not read.
 *
 * `dev` is not among the environments walked, and needs no special case: it is never declared, and the
 * declared set is what a deploy ever targets.
 */
export async function checkWorkflows(projectDir: string): Promise<WorkflowsCheck> {
  let project: string;
  let environments: readonly string[];
  try {
    const config = await loadProject(projectDir);
    project = requireProjectName(config);
    environments = loadProjectEnvironments(config);
  } catch {
    return { state: "could-not-check", drift: [] };
  }
  const drift = await workflowDrift(projectDir, project, environments);
  return { state: drift.length > 0 ? "drifted" : "ok", drift };
}
