// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailDatabase } from "../data/tables";

/**
 * The every-minute scheduler. It finds due rows — `scheduled`/`timezone` jobs whose `sendAt` has
 * arrived, plus the safety net of `pending` immediate jobs that never dispatched and `sending` jobs
 * left stale by a dead dispatch — claims them (status → `sending`, so the next tick won't repick them),
 * and fans them out into sender batches. **The fan-out scales with volume:** the more rows are due, the
 * more batches are dispatched, each its own durable send Workflow. Cron is cheap; this runs every
 * minute and does nothing when nothing is due.
 *
 * Jobs are claimed before dispatch, so a dispatch failure strands a row in `sending` rather than
 * double-sending; the `sending` re-drive (generous `stuckMs`) recovers it on a later tick, and
 * `runSend`'s idempotency makes any recovery a no-op for a job that did go out.
 */

/** Inputs the scheduler needs. `dispatch` creates one send Workflow per batch. */
export interface SchedulerDeps {
  db: EmailDatabase;
  now: Date;
  /** How stale (ms) a `pending` immediate job must be before the safety net re-drives it. */
  graceMs: number;
  /** How stale (ms) a `sending` job must be before it is treated as stranded and re-driven. */
  stuckMs: number;
  /**
   * Jobs per dispatched batch — one send Workflow each. From `SCHEDULER_BATCH_SIZE`.
   *
   * **A fan-out knob, and nothing else.** It has no ceiling: the claim statement sizes itself against
   * D1's bound-parameter cap independently, so raising this changes how many Workflows a tick starts and
   * cannot make a statement too wide. It used to be both, and 100 was enough to fail every tick (#250).
   */
  batchSize: number;
  /** The most jobs to claim in one tick. */
  maxJobs: number;
  /** Create a send Workflow for a batch of job ids. */
  dispatch: (jobIds: string[]) => Promise<void>;
}

/** What one scheduler tick did. */
export interface SchedulerResult {
  /** How many due jobs were claimed. */
  due: number;
  /** How many batches were dispatched (scales with volume). */
  batches: number;
}

/**
 * How many parameters the claim statement binds besides the job ids: `status` and `updatedAt`.
 *
 * Named here so that adding a column to the `set` is a one-number edit beside it, rather than a silent
 * re-break of a limit nobody re-derived.
 */
const CLAIM_FIXED_PARAMETERS = 2;

/**
 * Refuse a batch size that is not a count at all — checked before the tick does any work.
 *
 * `Number(env.SCHEDULER_BATCH_SIZE)` yields `NaN` for a typo, and `NaN` used to produce exactly one
 * empty batch: no job claimed, no job sent, no error, every minute. There is no safe number to clamp a
 * typo to, so it is named and refused.
 *
 * What is *not* refused is a large one. It carries no platform limit any more — see
 * {@link dispatchBatches}.
 */
function assertBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new ValidationError({
      message: "The email scheduler is misconfigured.",
      action: "Set SCHEDULER_BATCH_SIZE to a whole number of one or more, or unset it for the default of 50.",
      detail: `SCHEDULER_BATCH_SIZE resolved to ${batchSize}; it must be a positive integer.`,
    });
  }
}

/**
 * Split the due jobs into the batches this tick will dispatch — the **fan-out** split, not the
 * parameter one.
 *
 * The two used to be the same list, which is how `SCHEDULER_BATCH_SIZE` came to decide the width of a
 * D1 statement. They are separated now: this decides how many send Workflows a tick starts, and
 * {@link chunkByBoundParameters} decides how wide the claim that precedes each one may be. So the
 * operator's number carries no platform limit, and the platform limit needs no operator.
 */
function dispatchBatches(ids: string[], batchSize: number): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += batchSize) out.push(ids.slice(start, start + batchSize));
  return out;
}

/** Run one scheduler tick: find due rows, claim them, fan out batches. */
export async function runScheduler(deps: SchedulerDeps): Promise<SchedulerResult> {
  // Before the query, so a misconfigured worker says so on its first tick rather than on its first
  // busy one. An idle cron that quietly accepts a broken batch size is the shape of the bug, not a
  // reason to postpone the complaint.
  assertBatchSize(deps.batchSize);
  const nowMs = deps.now.getTime();
  const graceCutoff = nowMs - deps.graceMs;
  const stuckCutoff = nowMs - deps.stuckMs;

  const rows = await deps.db
    .selectFrom("pithyEmailJobs")
    .select(["id"])
    .where((eb) =>
      eb.or([
        eb.and([eb("status", "=", "scheduled"), eb("sendAt", "<=", nowMs)]),
        eb.and([eb("status", "=", "pending"), eb("createdAt", "<=", graceCutoff)]),
        eb.and([eb("status", "=", "sending"), eb("updatedAt", "<=", stuckCutoff)]),
      ]),
    )
    .orderBy("sendAt", "asc")
    .limit(deps.maxJobs)
    .execute();

  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { due: 0, batches: 0 };

  const batches = dispatchBatches(ids, deps.batchSize);
  let dispatched = 0;
  for (const batch of batches) {
    // Claim this batch first so a re-run never double-dispatches it, then start its send Workflow. The
    // claim is chunked against D1's cap, so a batch of any size is claimed in full before it dispatches
    // — a batch wider than one statement takes several, and the batch is still one unit of work.
    for (const claim of chunkByBoundParameters(batch, CLAIM_FIXED_PARAMETERS)) {
      await deps.db
        .updateTable("pithyEmailJobs")
        .set({ status: "sending", updatedAt: nowMs })
        .where("id", "in", claim)
        .execute();
    }
    await deps.dispatch(batch);
    dispatched += 1;
  }

  return { due: ids.length, batches: dispatched };
}
