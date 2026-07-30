// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
  /** Jobs per dispatched batch. */
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

/** Split a list into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run one scheduler tick: find due rows, claim them, fan out batches. */
export async function runScheduler(deps: SchedulerDeps): Promise<SchedulerResult> {
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

  const batches = chunk(ids, deps.batchSize);
  let dispatched = 0;
  for (const batch of batches) {
    // Claim this batch first so a re-run never double-dispatches it, then start its send Workflow.
    await deps.db
      .updateTable("pithyEmailJobs")
      .set({ status: "sending", updatedAt: nowMs })
      .where("id", "in", batch)
      .execute();
    await deps.dispatch(batch);
    dispatched += 1;
  }

  return { due: ids.length, batches: dispatched };
}
