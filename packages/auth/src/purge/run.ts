// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeContext, PurgeStep } from "@pithy-sh/core/src/capability/purge";
import {
  classifiedSteps,
  type TerminalErrorConstructor,
  type WorkflowStepLike,
} from "@pithy-sh/core/src/workflow/faults";
import {
  completePurge,
  type DuePurge,
  duePurges,
  type LifecycleDeps,
  mailPurgeComplete,
  purgeSubject,
  recordPurgeStep,
} from "../lifecycle/transitions";
import { authWorkflowRetry } from "./retryPolicy";
import { AUTH_CAPABILITY, type AuthPurgeDueParams, type AuthPurgeParams } from "./specs";

/**
 * The purge, as steps (#622) — the bodies `./workflow.ts` hands a Workflow's step runner to.
 *
 * ## One step per contribution, and the order they run in
 *
 * 1. **`due`** — is the account deleted, and has its window closed? A restored account, one inside its window,
 *    and one already erased all end the run here, having erased nothing. This is the one check a cron-started
 *    purge and a hard deletion's both pass through, so re-running a purge for the same subject exits cleanly.
 * 2. **`erase <capability>`** — one step per composed contribution, in composition order, each recording that it
 *    ran in `pithy_auth_user_lifecycle`. Handed to the platform's retry unclassified: an `erase` is idempotent by
 *    contract and runs code the kit did not write, so any fault in it is worth another attempt (`./retryPolicy.ts`).
 *    A failing contribution retries alone, and the ones that finished are served from the journal.
 * 3. **`mail`** — the deletion-complete mail, **before the address is erased**: every other capability's rows are
 *    gone, and auth's, which hold the address, are not yet. The address is read in the step, never carried out of
 *    one, so it is in no Workflow's journal.
 * 4. **`erase auth`** — auth's own contribution, last for that reason.
 * 5. **`complete`** — the `purged` record, the audit event, `onUserPurged`. Once.
 */

/** What a purge does with the account's own records — the transitions, over one set of dependencies. */
export interface PurgeOps {
  /** Whether the account is due: deleted, with its window closed. `gone` when there is no account. */
  due(userId: string): Promise<"due" | "not_due" | "gone">;
  /** Record that one capability's step erased its rows. */
  recordStep(userId: string, step: string, summary: string): Promise<void>;
  /**
   * Send the deletion-complete mail to the account's address, if it is still there to read, unless this purge's
   * `notify` or the deletion's own saved choice is false. Says whether.
   */
  mailComplete(userId: string, notify: boolean | undefined): Promise<boolean>;
  /** Write the `purged` record, the audit event and the hook. Says whether this call wrote them. */
  complete(userId: string): Promise<boolean>;
}

/** The operations, over the lifecycle transitions. */
export function purgeOps(deps: LifecycleDeps): PurgeOps {
  return {
    due: async (userId) => (await purgeSubject(deps, userId)).state,
    recordStep: (userId, step, summary) => recordPurgeStep(deps, { userId, step, summary }),
    mailComplete: async (userId, notify) => {
      const subject = await purgeSubject(deps, userId);
      if (subject.state !== "due") return false;
      // Either can silence it: the parameter a hard deletion started this purge with, or the choice that deletion
      // wrote on its history row — the one a purge the daily pass started still has (#622).
      const silenced = notify === false || subject.notify === false;
      return (await mailPurgeComplete(deps, { recipient: subject.recipient, ...(silenced ? { notify: false } : {}) }))
        .mailed;
    },
    complete: async (userId) => (await completePurge(deps, { userId })).changed,
  };
}

/** What one purge did: the account, how it ended, and the capabilities whose rows it erased. */
export interface PurgeOutcome {
  /** The account. */
  readonly userId: string;
  /** `purged`, or why nothing was erased: `not_due` (restored, or inside its window) and `gone` (no account). */
  readonly state: "purged" | "not_due" | "gone";
  /** Every step that erased its rows, in the order it ran. Empty when nothing was erased. */
  readonly erased: readonly string[];
  /** Whether the deletion-complete mail was enqueued. */
  readonly mailed: boolean;
}

/** What one purge reads its plan from: the composed contributions, this run's env, and its operations. */
export interface PurgeRun {
  /** Every composed purge step for `user`, auth's own among them. */
  readonly steps: readonly PurgeStep[];
  /** This run's bindings, handed to each contribution. */
  readonly env: Record<string, unknown>;
  /** The account's own records. */
  readonly ops: PurgeOps;
}

/** Run one account's purge, one step per contribution, auth's last. See the file header for the order. */
export async function purgeUser(
  run: PurgeRun,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
  params: AuthPurgeParams,
): Promise<PurgeOutcome> {
  const own = classifiedSteps(step, authWorkflowRetry, terminalError);
  const userId = params.userId;
  const state = await own.do("due", () => run.ops.due(userId));
  if (state !== "due") return { userId, state, erased: [], mailed: false };

  const context: PurgeContext = { subject: { type: "user", id: userId }, env: run.env };
  const auth = run.steps.filter((each) => each.step === AUTH_CAPABILITY);
  const others = run.steps.filter((each) => each.step !== AUTH_CAPABILITY);
  const erased: string[] = [];
  for (const each of others) {
    erased.push(await eraseStep(step, run.ops, each, context));
  }
  const mailed = await own.do("mail", () => run.ops.mailComplete(userId, params.notify));
  for (const each of auth) {
    erased.push(await eraseStep(step, run.ops, each, context));
  }
  await own.do("complete", () => run.ops.complete(userId));
  return { userId, state: "purged", erased, mailed };
}

/**
 * One capability's step: erase, then record that it ran. On the platform's own retry, unclassified — see the
 * file header. Recorded inside the same step, so a step that erased and failed to record is retried whole, and
 * the second erase finds nothing.
 */
function eraseStep(step: WorkflowStepLike, ops: PurgeOps, each: PurgeStep, context: PurgeContext): Promise<string> {
  return step.do(`erase ${each.step}`, async () => {
    await each.contribution.erase(context);
    await ops.recordStep(context.subject.id, each.step, each.contribution.summary);
    return each.step;
  });
}

/** How many purges one `start` step dispatches — a page, so one pass over a backlog is a bounded number of steps. */
export const PURGE_START_PAGE = 50;

/** The default size of one daily pass. */
export const PURGE_DUE_DEFAULT_LIMIT = 500;

/** What the daily pass reads and starts through. */
export interface PurgeDueRun {
  /** Every account whose purge is due, oldest first, at most `limit`, with the deletion it is due under. */
  due(limit: number): Promise<DuePurge[]>;
  /**
   * Start one account's purge — under the instance id its deletion names, so a start repeated is the same one.
   * Says whether the purge is running: started now, or found already started. `false` when it could not be
   * started, and the pass does not count it.
   */
  start(due: DuePurge): Promise<boolean>;
}

/**
 * The daily pass (#622): list every account past its window, and start a purge for each — in pages, one step
 * each, so a pass that dies part-way resumes after the page it finished rather than starting every purge
 * again. An account still inside its window is not listed, so it is not started.
 */
export async function startDuePurges(
  run: PurgeDueRun,
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
  params: AuthPurgeDueParams,
): Promise<{ started: number }> {
  const own = classifiedSteps(step, authWorkflowRetry, terminalError);
  const limit = params.limit ?? PURGE_DUE_DEFAULT_LIMIT;
  const due = await own.do("due", () => run.due(limit));
  let started = 0;
  for (let page = 0; page * PURGE_START_PAGE < due.length; page += 1) {
    const ids = due.slice(page * PURGE_START_PAGE, (page + 1) * PURGE_START_PAGE);
    started += await own.do(`start ${page + 1}`, async () => {
      // Counted from what each start answered, never from the page's length: a purge the binding could not start
      // is not running, and `{ started }` is what an operator reads to learn whether they are.
      let running = 0;
      for (const each of ids) if (await run.start(each)) running += 1;
      return running;
    });
  }
  return { started };
}

/** The daily pass's reads, over the lifecycle transitions. */
export function duePurgesOf(deps: LifecycleDeps): PurgeDueRun["due"] {
  return (limit) => duePurges(deps, limit);
}
