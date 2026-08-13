// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CohortPassResult, type DailyPassDeps, openCohortIds, runCohortPass } from "./daily";
import { logCohortFailure, logPassComplete } from "./report";
import type { TestersDailyParams } from "./specs";

/**
 * The durable daily pass — the body `TestersDailyWorkflow.run` hands its step runner to.
 *
 * **Why it is here and not in the Workflow class.** `worker.ts` imports `cloudflare:workers`, which
 * resolves in workerd and nowhere else, so anything inside it can only be exercised by deploying it.
 * The properties that matter about this body are all properties of a *resume* — a Workflow does not
 * resume inside the step it died in, it re-executes this function from the top and serves every
 * completed step from the journal — and the only way to know a resume behaves is to drive one. So the
 * step runner is structural and injected, exactly as `reconcilePayments` and `runAtRestKeyRotation`
 * take theirs, and `worker.ts` is the shell that supplies the real one.
 *
 * **One step per cohort.** A cohort whose activity read fails is retried on its own rather than taking
 * the rest of the day's cohorts down with it, and a retried step re-runs an idempotent pass.
 */

/** The durable step runner, structurally. Injected, so a test can drive an interrupt and a resume. */
export interface DailyPassStep {
  /** Run a named step, or return its journalled result if this instance already completed it. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * What a durable pass needs: everything one cohort's pass needs, minus the clock it journals itself.
 *
 * `now` is deliberately absent. It is the one value a caller must not supply here, because the whole
 * point of this function is that the instant is read once and read back from the journal on a resume.
 */
export interface DurableDailyPassDeps extends Omit<DailyPassDeps, "now"> {
  /**
   * The clock, for a test that wants a fixed one.
   *
   * A thunk rather than a `Date`, and read **inside** the `pass-instant` step: a `Date` here would be
   * a value the driver body already holds, which is the defect this function exists not to have.
   */
  readonly clock?: () => Date;
}

/** Run one durable daily pass: journal the instant it began, then one step per cohort. */
export async function runDurableDailyPass(
  deps: DurableDailyPassDeps,
  step: DailyPassStep,
  params: TestersDailyParams,
): Promise<CohortPassResult[]> {
  /**
   * The pass instant, journalled (pithy-sh/pithy#328).
   *
   * A Workflow re-executes this body from the top on a resume, so a clock read beside this line answers
   * differently on every attempt — and this clock decides the **day key** every snapshot is filed under.
   * A pass that began at 23:58 and resumed at 00:05 therefore filed its remaining cohorts under the next
   * day, splitting one run across two rows of a series that nothing later corrects. A straddling pass
   * belongs to the day it began: that is the day it sampled activity on, and the day whose position it
   * is recording.
   *
   * **The other clock is deliberately not this one.** Nudges are enqueued through `buildNudgeEnqueue`,
   * which reads its own clock per nudge, because the instant on an email job is `createdAt` and the email
   * scheduler re-drives a `pending` job older than `graceMs` on the assumption its dispatch died. A nudge
   * stamped with an instant this pass read an hour ago would be born already past that cutoff and raced
   * by a second send Workflow. Day key stable, enqueue fresh — they are two questions, and one variable
   * answering both is what this issue and pithy-sh/pithy#327 are each half of.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON: a `Date` would come back
   * a string on the resume and an object on the first pass.
   */
  const startedAtMs: number = await step.do("pass-instant", async () => (deps.clock ?? (() => new Date()))().getTime());
  const passDeps: DailyPassDeps = { ...deps, now: new Date(startedAtMs) };

  if (params.cohortId) {
    const result = await step.do(`cohort-${params.cohortId}`, () => runCohortPass(passDeps, params.cohortId as string));
    logPassComplete(deps.log, [result]);
    return [result];
  }

  // Enumerated in its own step, then one step per cohort — which is what the comment above has always
  // claimed and what every other Workflow in this repo does. A single `all-cohorts` step wrapping the
  // loop meant a deterministic failure on one cohort (a corrupt member row, a cohort deleted between
  // the list and the read) denied every cohort after it its snapshot and its nudges, on every retry
  // attempt, until retries ran out. The darkness histogram cannot be recomputed after the fact, so
  // those days were gone for good.
  const cohortIds: string[] = await step.do("list-cohorts", async () => await openCohortIds(deps.db));

  const results: CohortPassResult[] = [];
  for (const cohortId of cohortIds) {
    // Contained per cohort. A cohort that keeps failing loses its own day rather than everyone's, and
    // the failure is still visible in the Workflow instance rather than swallowed.
    try {
      results.push(await step.do(`cohort-${cohortId}`, () => runCohortPass(passDeps, cohortId)));
    } catch (error) {
      logCohortFailure(deps.log, cohortId, error);
    }
  }
  logPassComplete(deps.log, results);
  return results;
}
