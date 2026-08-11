// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { hostWorkflowsFor } from "@pithy-sh/core/src/workflow/host";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import { stringify } from "comment-json";
import { incompleteBindings } from "./appBindings";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * Workflows the adopter's **own app capability** declares, reconciled into that Worker's `wrangler.jsonc`.
 *
 * A library capability's Workflows already have a path: `pithy <capability> provision` deploys the host
 * Worker and `project/appBindings.ts` writes the cross-script binding. Nothing did it for the app's own,
 * so the `workflows` array, `triggers.crons`, and the per-environment repetition of both were hand-written
 * — each entry having to match the kit's `<project>-<env>-<capability>-<job>` rule and Cloudflare's segment
 * rule, which `workflowKey` asserts at assembly. A mistake therefore failed at deploy, not at the point of
 * writing.
 *
 * The names come from core's own `hostWorkflowsFor`, so an app-declared job is named by exactly the code
 * that names a library one. Nothing here formats a name.
 *
 * **What still belongs to the adopter: the class.** Cloudflare resolves a `class_name` in the script named
 * by the binding, so the `WorkflowEntrypoint` subclass has to be exported from the Worker's `main`. That is
 * five lines written once. The per-environment binding table is not.
 */

/**
 * One `workflows` entry for a job the app capability declares. It carries **no `script_name`**: the class
 * lives in this Worker's own `main`, so the binding is same-script. A library capability's entry does carry
 * one, and that difference is how {@link reconcileAppWorkflows} tells the two apart in a stanza it did not
 * write alone.
 */
export interface AppOwnedWorkflow {
  /** The binding name the Worker env exposes, e.g. `KEY_ROTATION`. */
  binding: string;
  /** The deployed Workflow name, `<project>-<env>-<capability>-<job>`. */
  name: string;
  /** The exported `WorkflowEntrypoint` subclass that runs the job. */
  class_name: string;
}

/** What one environment's stanza should say: the app's own `workflows` entries, and the crons that fire them. */
export interface AppWorkflowPlan {
  /** Complete entries, one per job the app declares, in declaration order. */
  workflows: AppOwnedWorkflow[];
  /** The declared cron schedules, deduplicated. Empty when no job is scheduled. */
  crons: string[];
}

/** The identity an app-declared Workflow's name is composed from. */
export interface AppWorkflowNameParts {
  /**
   * The project name — the root `pithy.config.ts` `name`, from `requireProjectName` and never guessed.
   * Workflow names are account-scoped, so a guessed project deploys under a name another project owns.
   */
  project: string;
  /** The target environment. `dev` is a real environment here: it names the local Workflow too. */
  env: string;
}

/**
 * What one environment's stanza should say, derived from the app capability alone.
 *
 * Thin over core's {@link hostWorkflowsFor}, which already refuses a job with no `className` and already
 * composes the name — the deliberate point being that an app-declared job and a library-declared one get
 * their names from one function. The host's entries are the app's minus `script_name`, so the extra field
 * is dropped rather than a second name-composer being written.
 */
export function planAppWorkflows(app: Capability, parts: AppWorkflowNameParts): AppWorkflowPlan {
  const registry = composeWorkflows([app]);
  const { workflows, crons } = hostWorkflowsFor(registry, {
    project: parts.project,
    capability: app.name,
    env: parts.env,
  });
  return {
    workflows: workflows.map(({ binding, name, class_name }) => ({ binding, name, class_name })),
    // Two jobs on one schedule are one cron: the Worker has a single `scheduled` handler and it fires
    // every scheduled job on any tick, so a repeated expression is a duplicated run, not a second job.
    crons: [...new Set(crons)],
  };
}

/** The wrangler slice this module reads and writes. Unknown keys survive untouched — comment-json holds them. */
export interface WorkflowStanza {
  workflows?: (AppOwnedWorkflow & { script_name?: string })[];
  triggers?: { crons?: string[] };
}

/** The whole config: the top-level stanza (wrangler's default environment) plus each named one. */
export interface WorkflowConfig extends WorkflowStanza {
  env?: Record<string, WorkflowStanza | undefined>;
}

/**
 * Is this `workflows` entry the app capability's own?
 *
 * **One predicate, because the writer and the reader have to mean the same thing by it.** An entry
 * carrying a `script_name` is a library capability's, written by that capability's provisioner and
 * pointing at its host Worker. Everything else is same-script, which in this Worker means app-declared —
 * that is what lets {@link reconcileAppWorkflows} replace the whole set rather than upsert it, and it is
 * what `project/workflows.ts` reads back to ask whether the stanza binds what the app declares. Two
 * copies of this rule would be two answers to "whose entry is this?", and drift the check could not see.
 */
function isAppOwned(entry: { script_name?: string }): boolean {
  return entry.script_name === undefined;
}

/**
 * The app's own entries in one stanza's `workflows` table — the table {@link reconcileAppWorkflows}
 * replaces, and the one the doctor and deploy readers compare against the declaration.
 *
 * The extra `script_name` field is not carried, because by definition these have none: the shape returned
 * is exactly {@link planAppWorkflows}'s, so the comparison is between two values of one type.
 */
export function appOwnedWorkflows(stanza: WorkflowStanza | undefined): AppOwnedWorkflow[] {
  return (stanza?.workflows ?? [])
    .filter(isAppOwned)
    .map(({ binding, name, class_name }) => ({ binding, name, class_name }));
}

/** Options for {@link reconcileAppWorkflows}. */
export interface ReconcileAppWorkflowsOptions {
  /** The Worker's directory — `apps/<name>`, where its `wrangler.jsonc` lives. */
  workerDir: string;
  /** The project name, from `requireProjectName`. */
  project: string;
  /** The Worker's own app capability — the one whose `workflows` map is the source of truth. */
  app: Capability;
  /** Narrow to one environment. Omitted reconciles the top-level stanza and every `env.<name>` already declared. */
  env?: string;
}

/** What one environment's reconciliation did. */
export interface AppWorkflowRun {
  /** The environment reconciled — `dev` for the top-level stanza. */
  env: string;
  /** The entries its `workflows` table now declares for the app, verbatim as written. */
  workflows: AppOwnedWorkflow[];
  /** The cron schedules its `triggers` now carries. */
  crons: string[];
  /** Whether anything moved. False on a re-run with nothing to change. */
  changed: boolean;
}

/**
 * The environments a run visits: the one named, else the top-level stanza plus every `env.<name>` the
 * Worker already declares.
 *
 * Deriving the set from the file is the point — the defect was writing the same table once per environment
 * by hand, so an adopter who adds `prod` later must not have to remember this command's argument list. An
 * explicit `--env` still creates a stanza that is not there yet, because naming one is asking for it.
 */
function environmentsOf(config: WorkflowConfig, env: string | undefined): string[] {
  if (env !== undefined) return [env];
  return ["dev", ...Object.keys(config.env ?? {})];
}

/** The stanza for an environment, created when absent. `dev` is the top-level one — wrangler has no `env.dev`. */
function stanzaFor(config: WorkflowConfig, env: string): WorkflowStanza {
  if (env === "dev") return config;
  config.env ??= {};
  const existing = config.env[env] ?? {};
  config.env[env] = existing;
  return existing;
}

/**
 * Replace the app's own entries in one stanza, leaving every provisioned one in place.
 *
 * An entry carrying a `script_name` is a library capability's, written by that capability's provisioner and
 * pointing at its host Worker — untouchable here. Everything else is same-script, which in this Worker means
 * app-declared, so the whole set is replaced rather than upserted: a job the app renamed or dropped must
 * leave, and an upsert by binding name would strand it. The provisioned entries keep their positions ahead
 * of the app's, so a re-run produces a byte-identical file.
 */
function replaceOwnWorkflows(stanza: WorkflowStanza, plan: AppWorkflowPlan): void {
  const provisioned = (stanza.workflows ?? []).filter((entry) => !isAppOwned(entry));
  const next = [...provisioned, ...plan.workflows];
  if (stanza.workflows) {
    // In place: comment-json keeps an array's comments as symbol-keyed properties on the array object,
    // so a fresh array would silently drop the adopter's notes.
    stanza.workflows.length = 0;
    stanza.workflows.push(...next);
  } else if (next.length > 0) {
    stanza.workflows = next;
  }
}

/**
 * Set the stanza's cron schedule to what the app declares.
 *
 * Set, not merge. `createEntrypoint` gives a Worker one `scheduled` handler that starts **every** job
 * carrying a schedule, whatever cron fired — so an expression nothing declares is not an extra job, it is
 * every job running again at a time nobody asked for. The declaration is therefore the whole truth, and a
 * schedule the adopter changes takes its old value with it.
 *
 * **An emptied schedule is written as `[]`, never as a deleted key.** Wrangler reads an absent `crons` as
 * "not declared" and leaves the deployed Worker's schedule exactly as it was, so deleting the key when the
 * app drops its last schedule would leave the old cron firing every job that remains — a reconcile that
 * reports `Done.` and changes nothing where it matters. A stanza that never carried crons is still left
 * alone, because a `triggers` block a project never had is noise in every config whose jobs all dispatch.
 */
function setCrons(stanza: WorkflowStanza, crons: string[]): void {
  if (crons.length === 0 && stanza.triggers?.crons === undefined) return;
  stanza.triggers ??= {};
  stanza.triggers.crons = crons;
}

/**
 * Reconcile the app capability's declared Workflows and cron schedule into the Worker's `wrangler.jsonc` —
 * the seam behind `pithy worker sync`.
 *
 * Idempotent, comment-preserving, and all-or-nothing: every environment is computed and checked before the
 * file is written once, so a stanza wrangler would reject aborts the run rather than leaving half a config
 * behind. An app that declares no Workflows writes nothing at all — including no empty `workflows` key,
 * which wrangler reads as a declaration.
 *
 * **An app that declares none is still reconciled**, and that is not the same statement. It used to
 * return before the file was opened, which made "the declaration is the truth" false in the one case
 * where it matters most: drop the last job from `pithy.config.ts` and the binding and the cron stayed in
 * `wrangler.jsonc` forever, with no command that would take them out and — since #267 — a doctor fault
 * naming a command that could not answer it. The empty declaration is a declaration. What it writes is
 * still nothing at all where there was nothing: `replaceOwnWorkflows` creates no `workflows` key and
 * `setCrons` creates no `triggers` block, so a project that never had either is byte-identical after.
 */
export async function reconcileAppWorkflows(options: ReconcileAppWorkflowsOptions): Promise<AppWorkflowRun[]> {
  const { workerDir, project, app, env } = options;

  const config = (await readWranglerConfig(workerDir)) as WorkflowConfig;
  const before = stringify(config);

  const runs: AppWorkflowRun[] = [];
  for (const target of environmentsOf(config, env)) {
    const plan = planAppWorkflows(app, { project, env: target });
    const stanza = stanzaFor(config, target);
    const stanzaBefore = stringify(stanza);

    replaceOwnWorkflows(stanza, plan);
    setCrons(stanza, plan.crons);

    // Never write a config wrangler will not load. A hand-edited entry that lost a field lands here too,
    // which is the right place to hear about it — before the next deploy.
    const problems = incompleteBindings(stanza);
    if (problems.length > 0) {
      throw new InternalError({
        message: `wrangler.jsonc would not load with the ${target} bindings.`,
        action: `Fix the ${target} bindings in ${workerDir}/wrangler.jsonc by hand, then run pithy worker sync again.`,
        detail: problems.join("; "),
      });
    }

    runs.push({
      env: target,
      workflows: plan.workflows,
      crons: plan.crons,
      changed: stringify(stanza) !== stanzaBefore,
    });
  }

  if (stringify(config) !== before) await writeWranglerConfig(workerDir, config);
  return runs;
}
