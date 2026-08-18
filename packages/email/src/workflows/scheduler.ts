// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailDatabase } from "../data/tables";

/**
 * The every-minute scheduler. It finds due rows — `scheduled`/`timezone` jobs whose `sendAt` has
 * arrived, plus the safety net of `pending` and `undispatched` immediate jobs that never dispatched and
 * `sending` jobs left stale by a dead dispatch — claims them (status → `sending`, so the next tick won't
 * repick them), and fans them out into sender batches. **The fan-out scales with volume:** the more rows are due, the
 * more batches are dispatched, each its own durable send Workflow. Cron is cheap; this runs every
 * minute and does nothing when nothing is due.
 *
 * Jobs are claimed before dispatch, so a dispatch failure strands a row in `sending` rather than
 * double-sending; the `sending` re-drive recovers it on a later tick, and `runSend`'s idempotency makes
 * any recovery a no-op for a job that did go out.
 *
 * **The claim is the batch.** Every job claimed in one dispatch carries that batch's id, which is the id
 * of the send Workflow instance started for it, so the tick that finds those rows stale can ask the
 * runtime whether the batch is still alive instead of guessing from a timestamp. That is the whole of
 * the re-drive decision (pithy-sh/pithy#342), and it costs the claim one column and the tick one question
 * per batch.
 */

/** Inputs the scheduler needs. `dispatch` creates one send Workflow per batch. */
export interface SchedulerDeps {
  db: EmailDatabase;
  now: Date;
  /** How stale (ms) a `pending`/`undispatched` immediate job must be before the safety net re-drives it. */
  graceMs: number;
  /**
   * How stale (ms) a job must be before this tick will *consider* re-driving it.
   *
   * **It is a filter, not the verdict.** A row's timestamp cannot say whether the batch holding it is
   * alive: a batch is claimed whole and walked one job at a time, so a job it has not reached carries the
   * claim instant however busy the batch is, and a step waiting out its retry backoff writes nothing at
   * all while being entirely alive. {@link SchedulerDeps.batchIsAlive} settles both; this only decides
   * what is old enough to ask about (pithy-sh/pithy#342).
   *
   * So it is not a knob for outrunning a long queue. Widening it to cover one would be a race with a
   * slower horse, and the queue gets longer.
   */
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
  /**
   * Mint the id of a batch about to be dispatched. It **is** the send Workflow's instance id, which is
   * what lets {@link SchedulerDeps.batchIsAlive} ask the runtime about it later.
   */
  newBatchId: () => string;
  /**
   * Is the send Workflow instance holding this batch still alive? (pithy-sh/pithy#342)
   *
   * The question a row cannot answer. A Workflow that exists and is scheduled to retry is alive, and its
   * rows are as untouched as a dead dispatch's; a batch three quarters of the way down a long queue is
   * alive, and the quarter it has not reached is as untouched again. Both used to read as stranded, and
   * a re-drive of either is a second send Workflow over a job the first will reach — a double-send.
   *
   * **It may only ever veto a re-drive, never cause one.** A stale row with no batch, or one whose batch
   * this cannot vouch for, is re-driven exactly as it was before this existed. That is what keeps the
   * safety net intact and makes the new question incapable of sending an extra email: the worst an
   * unavailable answer can do is decline to save one.
   */
  batchIsAlive: (batchId: string) => Promise<boolean>;
  /** Create a send Workflow for a batch of job ids, under the batch's id as the instance id. */
  dispatch: (batchId: string, jobIds: string[]) => Promise<void>;
}

/** What one scheduler tick did. */
export interface SchedulerResult {
  /** How many due jobs were claimed. */
  due: number;
  /** How many batches were dispatched (scales with volume). */
  batches: number;
  /** How many stale-looking jobs were left alone because the batch holding them is still alive. */
  held: number;
}

/**
 * How many parameters the claim statement binds besides the job ids: `status`, `updatedAt`, `batchId`.
 *
 * Named here so that adding a column to the `set` is a one-number edit beside it, rather than a silent
 * re-break of a limit nobody re-derived.
 */
const CLAIM_FIXED_PARAMETERS = 3;

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

/**
 * Drop the candidates a live batch still holds, and return the rest (pithy-sh/pithy#342).
 *
 * A candidate is a row the timestamps say *might* be stranded. Deciding it actually is takes the batch,
 * so every row naming one is settled by {@link SchedulerDeps.batchIsAlive} — asked **once per batch**,
 * not once per row, because fifty rows of a stalled batch are one question about one Workflow.
 *
 * A row naming no batch is stranded by definition: nothing claimed it, or whatever did died before it
 * could say so. That is the safety net, and it is deliberately untouched here.
 */
async function strandedIds(
  deps: SchedulerDeps,
  rows: readonly { id: string; batchId?: string | null }[],
): Promise<string[]> {
  const answered = new Map<string, boolean>();
  const stranded: string[] = [];
  for (const row of rows) {
    const batchId = row.batchId;
    if (batchId) {
      let alive = answered.get(batchId);
      if (alive === undefined) {
        alive = await deps.batchIsAlive(batchId);
        answered.set(batchId, alive);
      }
      if (alive) continue;
    }
    stranded.push(row.id);
  }
  return stranded;
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
    .select(["id", "batchId"])
    .where((eb) =>
      eb.or([
        eb.and([eb("status", "=", "scheduled"), eb("sendAt", "<=", nowMs)]),
        // `undispatched` beside `pending`, and it is the whole recovery path for one
        // (pithy-sh/pithy#410). A row born `undispatched` was enqueued by a composition that binds no
        // send Workflow — deployed before `pithy <capability> provision`, or a plain `wrangler dev` —
        // and the tick reading this query is running on the host that composition was missing. So the
        // first tick after the host exists is what drains that backlog; without this line the row is a
        // dead end, because `retryJob` takes only `failed` and no command moves it.
        eb.and([eb("status", "in", ["pending", "undispatched"]), eb("createdAt", "<=", graceCutoff)]),
        eb.and([eb("status", "=", "sending"), eb("updatedAt", "<=", stuckCutoff)]),
      ]),
    )
    .orderBy("sendAt", "asc")
    .limit(deps.maxJobs)
    .execute();

  if (rows.length === 0) return { due: 0, batches: 0, held: 0 };

  const ids = await strandedIds(deps, rows);
  const held = rows.length - ids.length;
  if (ids.length === 0) return { due: 0, batches: 0, held };

  const batches = dispatchBatches(ids, deps.batchSize);
  let dispatched = 0;
  for (const batch of batches) {
    // The batch's id, minted before the claim so the rows can carry it: it is the send Workflow's
    // instance id, and a row that names it is a row the next tick can ask the runtime about.
    const batchId = deps.newBatchId();
    // Claim this batch first so a re-run never double-dispatches it, then start its send Workflow. The
    // claim is chunked against D1's cap, so a batch of any size is claimed in full before it dispatches
    // — a batch wider than one statement takes several, and the batch is still one unit of work.
    for (const claim of chunkByBoundParameters(batch, CLAIM_FIXED_PARAMETERS)) {
      await deps.db
        .updateTable("pithyEmailJobs")
        .set({ status: "sending", updatedAt: nowMs, batchId })
        .where("id", "in", claim)
        .execute();
    }
    await deps.dispatch(batchId, batch);
    dispatched += 1;
  }

  return { due: ids.length, batches: dispatched, held };
}
