// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isSourceEnvironment } from "../provision/featureConfig";
import {
  type AppWorkflowPlan,
  appOwnedWorkflows,
  planAppWorkflows,
  type WorkflowConfig,
  type WorkflowStanza,
} from "./appWorkflows";
import { loadProject, loadProjectEnvironments, loadWorkerConfig, requireProjectName } from "./config";
import { discoverWorkers } from "./workers";
import { readOptionalWranglerConfig } from "./wrangler";

/**
 * **What the app capability declares is what the environment's stanza binds.**
 *
 * That is the whole invariant, and until #267 nothing asked it. `reconcileAppWorkflows` derives the
 * `workflows` table and `triggers.crons` from the `app` capability's `workflows` map and writes them into
 * `wrangler.jsonc`; its only caller is `pithy worker sync`; and no check anywhere read the two halves back.
 * The same structure as #264 one file over — a declaration in `pithy.config.ts`, a fact in
 * `wrangler.jsonc`, one writer, no reader — and the same ending: an adopter who declares a job and never
 * runs `sync` gets a green `pithy doctor`, a green `pithy deploy`, and a Worker that ships with no
 * `workflows` entry and no `triggers.crons`.
 *
 * What that costs is worth naming, because two of the three failures are loud and the third is not:
 *
 * - **The cron never fires.** Nothing is wrong anywhere. No request fails, no log line appears, no probe
 *   goes red. The job simply does not run, and the first sign of it is whatever the job existed to
 *   prevent. This is the failure this reader exists for.
 * - **`c.var.workflows.trigger("board/digest", …)` cannot reach a binding wrangler never wrote.** Loud,
 *   at least: `createBackend` derives a `workflow` binding spec from every registered job, so a
 *   non-`optional` one that is absent fails `validateBindings` on the Worker's first request.
 * - **A binding that carries another environment's name** — the shape a copy-pasted stanza produces —
 *   starts instances of a Workflow deployed for somewhere else.
 *
 * ## The question is asked once, of the whole table
 *
 * Not "is every declared job bound?" plus "is every bound job declared?" plus "is every cron declared?".
 * Those are three ways for one comparison to come out, and a gate written as a list of them is a gate
 * that will one day be missing the fourth — which is exactly how #264 shipped, asking what `workers_dev`
 * was set to instead of what serves the host. So the declaration is reduced to the table it implies
 * (through {@link planAppWorkflows}, the same function the writer plans with, so the two cannot disagree
 * about what "declared" means), the stanza's own app-owned table is read back beside it (through
 * {@link appOwnedWorkflows}, the same rule the writer replaces by), and the two are compared whole. A
 * missing binding, a stale binding, a stale cron and a wrong name are all one fault with one remedy,
 * and so is anything else that can make the two differ.
 *
 * Order is deliberately not part of it. Cloudflare reads a table, the array's order carries no meaning,
 * and a fault against a hand-ordered stanza that binds exactly the right things would be noise.
 *
 * ## What it does not claim
 *
 * A Worker whose `pithy.config.ts` will not import (dependencies not installed, most often) makes no
 * claim at all — the #264 rule, for the same reason: "this declares no jobs" is a negative finding, and a
 * config nobody could open is precisely the one that might have declared some. A Worker with no `app`
 * capability makes none either: there is no declaration to compare against, and `pithy worker sync`
 * writes nothing for it, so a fault there would name a command that cannot answer it.
 *
 * Files only, offline, no account call — the standard `originDrift` and `unprovisionedBindings` are held
 * to, and the reason this can gate a deploy without costing it a round trip.
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
  worker: string;
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

/** What one environment's stanza binds for this Worker's own script — the right-hand side of the comparison. */
function boundBy(stanza: WorkflowStanza | undefined): AppWorkflowPlan {
  return { workflows: appOwnedWorkflows(stanza), crons: [...(stanza?.triggers?.crons ?? [])] };
}

/**
 * One Worker's app capability, or `undefined` when there is no declaration to compare against.
 *
 * The two cases collapse deliberately. A config that will not import declares nothing *knowable*, and a
 * Worker with no `app` block declares nothing *at all* — and in both, the honest output is silence
 * rather than a fault naming a command that would report, correctly and uselessly, that it wrote nothing.
 */
async function workerApp(workerDir: string): Promise<Capability | undefined> {
  try {
    return (await loadWorkerConfig(workerDir)).app;
  } catch {
    return undefined;
  }
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
    const app = await workerApp(target.dir);
    if (!app) continue;
    const worker = basename(target.dir);
    for (const env of environments) {
      let declared: AppWorkflowPlan;
      try {
        declared = planAppWorkflows(app, { project, env });
      } catch (error) {
        // Reported, never rethrown. `planAppWorkflows` refuses a job it cannot name, and a check that
        // let that escape would take doctor's whole block down to a `catch` and say nothing at all —
        // which is the failure mode this file exists to remove, reintroduced one level up.
        drift.push({
          worker,
          env,
          fault: "unwritable-declaration",
          declared: NOTHING,
          bound: NOTHING,
          reason: messageOf(error),
        });
        continue;
      }
      const bound = boundBy(config.env?.[env]);
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
  if (drift.fault === "unwritable-declaration") {
    return `${drift.worker} declares a job nothing can bind in ${drift.env}: ${drift.reason} Fix workflows in the Worker's pithy.config.ts — pithy worker sync would refuse it the same way.`;
  }
  return `${drift.worker} declares ${summarize(drift.declared)} for ${drift.env}, and env.${drift.env} binds ${summarize(drift.bound)}. Run pithy worker sync to write the declaration into wrangler.jsonc.`;
}

/** The throw-site context behind each fault — why this one is worth a refusal. */
function workflowDetail(fault: WorkflowFault): string {
  return fault === "unwritable-declaration"
    ? "hostWorkflowsFor refuses a job it cannot name, so there is no stanza any command could write for this environment."
    : "A declared Workflow and the binding that runs it are two halves of one fact in two files, and only pithy worker sync writes the second — so a cron nothing bound never fires, and nothing anywhere reports it.";
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
  throw new ValidationError({
    message: `${env} does not bind what it declares: ${drift.map((entry) => entry.worker).join(", ")}.`,
    action: drift.map(describeWorkflowDrift).join(" "),
    detail: workflowDetail(first.fault),
  });
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
