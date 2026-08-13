// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { EmailDatabase } from "../data/tables";

/**
 * Renew the scheduler's claim on the jobs a batch still holds (pithy-sh/pithy#340).
 *
 * **Liveness is a property of the batch, not of a row.** `runScheduler` claims a whole batch up front —
 * every id stamped with the one instant of the claim — and only then dispatches a single send Workflow
 * for it. Whatever that Workflow is currently doing, it holds every job on that list; a job it has not
 * reached yet is not stranded, it is queued behind one that is being worked on.
 *
 * The scheduler cannot see that. It reads one column, `updatedAt`, and only the job in a step is
 * written to. So the tail keeps the claim instant, ages past `stuckMs`, and gets re-driven out from
 * under a batch that is still coming for it — two send Workflows over one `sending` job, and `runSend`
 * short-circuits only a job already `sent`. Both render. Both send. That is #327's outcome arriving from
 * the direction #327's fix did not cover, and it needs no crash and no resume: it needs a queue longer
 * than the timeout.
 *
 * So the batch says what only the batch knows. This is the statement of it, and the scheduler's read is
 * unchanged — `updatedAt` still means "work happened on this job, recently", it is simply now written by
 * the whole batch rather than by one step of it.
 *
 * **Not by widening `stuckMs`.** A timeout tuned to outrun a queue is a race with a slower horse, and
 * every job an adopter adds lengthens the queue. The signal is made true instead of made generous.
 */

/**
 * Everything this binds besides the ids: `updatedAt` in the `set`, `status` in the `where`.
 *
 * Named so that adding a column to either is a one-number edit beside it. The tail is as long as
 * `SCHEDULER_BATCH_SIZE` says, and that variable has no ceiling — an unchunked `in (…)` over it is the
 * statement that failed every cron tick in #250.
 */
const RENEW_FIXED_PARAMETERS = 2;

/**
 * Stamp `updatedAt` on every still-`sending` job in `jobIds`, at `at`.
 *
 * `at` is the heartbeat clock — read fresh, never the journalled pass instant. A renewal on the pass
 * instant would re-write the claim time on every pass and say nothing at all.
 *
 * The `status` guard is what keeps this from lying in the other direction. It renews a claim; it does
 * not resurrect one. A job that left `sending` while the batch still listed it — cancelled by an
 * operator, or written by the bounce handler — is no longer held, and a row kept perpetually fresh is a
 * row the safety net can never recover.
 */
export async function renewClaim(db: EmailDatabase, jobIds: readonly string[], at: Date): Promise<void> {
  for (const chunk of chunkByBoundParameters(jobIds, RENEW_FIXED_PARAMETERS)) {
    await db
      .updateTable("pithyEmailJobs")
      .set({ updatedAt: SQLiteDate.encode(at) })
      .where("status", "=", "sending")
      .where("id", "in", chunk)
      .execute();
  }
}
