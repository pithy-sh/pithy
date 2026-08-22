// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailJob } from "../data/emailJob";
import type { EmailDatabase, EmailSuppressionDatabase } from "../data/tables";
import { EmailSuppressedError } from "../error/errors";
import { mintBatchId } from "../send/batchIdentity";
import type { SendWorkflowBinding } from "../send/enqueue";
import { blockingSuppression } from "../send/suppression";
import { templateKind } from "../templates/engine";
import { getJob } from "./read";

/**
 * Putting a failed job back in the queue — the body behind `POST /email/jobs/:id/retry`.
 *
 * ## A handler never sends
 *
 * `runSend` is Workflow-only and is never called from here. A retry does what `enqueueEmail` does: it
 * puts the row back into a sendable state and dispatches the send Workflow. That keeps the one place
 * that talks to the Email Service inside a durable step with retries and history, which is the whole
 * reason email is a job table rather than a function call.
 *
 * A failed dispatch is safe and deliberately swallowed. The row is `pending` before the Workflow is
 * started, so the every-minute scheduler's safety net re-drives it on the next tick — the same contract
 * `enqueueEmail` relies on. Losing the dispatch costs a minute; failing the request after the row was
 * already reset would tell an operator nothing happened when something did.
 *
 * ## Only a `failed` job may be retried
 *
 * Every other state is refused with `core/conflict`, and each refusal is a different thing going wrong:
 *
 * - `sent` — already delivered. Retrying is a duplicate email to a real person. It is also the one
 *   state whose inputs are gone: a transactional job's payload is dropped when the message goes out,
 *   which is safe precisely because this refusal is what makes `sent` terminal.
 * - `pending` / `scheduled` / `sending` — still in flight. Resetting it races the scheduler, and
 *   `sending` in particular is a job a Workflow is holding right now.
 * - `suppressed` — the address is on the block list. Retrying is the one send this capability must
 *   never make.
 * - `bounced` — the recipient's server said permanently no, and the bounce handler only sets this
 *   state while suppressing the address, so a retry is the previous case wearing a different label.
 * - `canceled` — somebody withdrew it. Reviving a withdrawal is a separate decision, not a retry, and
 *   it should have to be made somewhere it is named.
 *
 * ## The attempt budget is reset, and it has to be
 *
 * `runSend` gives up when `attempts >= maxAttempts`. A job that failed did so having spent its budget,
 * so a retry that left `attempts` alone would take one retryable error to fail terminally again — the
 * button would appear to work and change nothing. `attempts` returns to zero; `error` does not, because
 * it is the record of what went wrong last time and a successful send clears it anyway.
 *
 * ## The batch id is re-minted, and the old one must not survive
 *
 * A `failed` row still names the batch that failed it (pithy-sh/pithy#342), and that id is about to
 * become wrong in both directions at once. `batchId` means *the instance coming for this row* — see
 * `send/batchIdentity.ts` — and after a retry the instance coming for it is the one this function
 * starts, not the one that gave up on it.
 *
 * Leaving the old id there is not a stale label. It hands the scheduler's veto the wrong Workflow to ask
 * about, and a failure inside a batch is exactly the case where that Workflow is *still running*: a
 * batch of fifty that failed job seven walks on to job fifty. So the tick that should re-drive the retry
 * asks about the batch that abandoned it, is told "alive", and holds — the operator's click sends
 * nothing for as long as the old batch runs. Then the old batch ends, the same row reads as stranded,
 * and the tick starts a second Workflow behind the one this function already started. Held when it
 * should send, then sent twice: one wrong id, both failures.
 *
 * So a retry mints its own, writes it in the same statement that makes the row queryable again, and
 * creates the instance under it. Null when there is no binding to dispatch on, because then nothing is
 * coming for the row and the scheduler should claim it on the next tick — and the row is `undispatched`
 * rather than `pending` there, for the reason the write itself states.
 */

/** What a retry needs: both databases, the send Workflow binding, and the clock. */
export interface RetryDeps {
  /** The per-environment jobs database. */
  db: EmailDatabase;
  /** The global suppression database — checked before the row is touched. */
  suppressionDb: EmailSuppressionDatabase;
  /**
   * The send Workflow binding. Optional so a Worker that somehow lacks it still resets the row and
   * leaves the scheduler to re-drive, rather than failing an operator's click outright.
   */
  sender?: SendWorkflowBinding;
  now: Date;
  /**
   * Mint the id of the batch this retry dispatches — **the send Workflow instance's id**
   * (pithy-sh/pithy#342). Defaults to {@link mintBatchId}; injected only so a test can name it.
   */
  newBatchId?: () => string;
}

/** What a retry did. */
export interface RetryResult {
  /** The job that was re-queued. */
  job: EmailJob;
  /**
   * Whether the send Workflow actually started. False means the scheduler will pick the row up within
   * the minute — the mail is not lost, it is merely not immediate.
   */
  dispatched: boolean;
}

/**
 * Re-queue one failed job.
 *
 * Reads before it writes: the job must exist, be `failed`, and its recipient must not have been
 * suppressed in the meantime. That last check is not redundant with `runSend`'s — `runSend` would mark
 * the row `suppressed` and skip, which reports to the operator as a successful retry that silently sent
 * nothing. Refusing here says what actually happened.
 */
export async function retryJob(deps: RetryDeps, jobId: string): Promise<RetryResult> {
  const existing = await getJob(deps.db, jobId);
  if (!existing) {
    throw new NotFoundError({
      message: "No such email job.",
      action: "Check the job id against the send log.",
      detail: `email job '${jobId}' not found`,
    });
  }

  if (existing.status !== "failed") {
    throw new ConflictError({
      message: `Only a failed job can be retried. This one is ${existing.status}.`,
      action: "Retry a job whose status is failed.",
      detail: `email job '${jobId}' is ${existing.status}`,
    });
  }

  const recipient = normalizeAddress(existing.toAddress);
  // Asked the same way `runSend` asks it, kind included. An operator retrying a failed magic link to
  // somebody who unsubscribed from a newsletter must not be told the address is unreachable — the send
  // would go through, so refusing it here would be this capability inventing a block of its own.
  const blocked = await blockingSuppression(deps.suppressionDb, recipient, deps.now, templateKind(existing.template));
  if (blocked) {
    throw new EmailSuppressedError({
      message: `That recipient is on the suppression list (${blocked}), so this job cannot be retried.`,
      action: "Remove the address from the suppression list first, if that is what you mean to do.",
      detail: `recipient of email job '${jobId}' is suppressed: ${blocked}`,
    });
  }

  // The batch this retry will start, named before the row is written so the same statement that makes
  // the row queryable again also says who is coming for it. Null with no binding: nothing is.
  const batchId = deps.sender ? (deps.newBatchId ?? mintBatchId)() : null;

  const updated = await deps.db
    .updateTable("pithyEmailJobs")
    .set({
      // **The failed batch's id does not survive the retry** — see the note above. Whether it is
      // re-minted or nulled, what must not happen is the row keeping the id of the batch that gave up on
      // it, because that batch is usually still running and its liveness would be read as this row's.
      batchId,
      // `pending`, whatever the original mode was. A retry is an operator asking for this to go now;
      // re-arming a `scheduled` job to a `sendAt` that is already in the past would say the same thing
      // less clearly, and re-deriving a `timezone` job's local slot would move the send to tomorrow.
      //
      // With no binding it is `undispatched` instead — the same word `enqueueEmail` writes for the very
      // same env (pithy-sh/pithy#410). One deployment must not have two names for one configuration
      // fact: `pending` here would tell an operator their click queued a send while an enqueue two
      // lines away was recording that this composition can start none. The scheduler claims either, so
      // the retry is deferred and not dropped.
      status: deps.sender ? "pending" : "undispatched",
      sendAt: SQLiteDate.encode(deps.now),
      attempts: 0,
      updatedAt: SQLiteDate.encode(deps.now),
      // **`createdAt` is reset too, and it is load-bearing.** The scheduler's safety net for an
      // immediate job is `status = 'pending' AND createdAt <= now - graceMs`, and that grace exists so a
      // job that has just been dispatched by whoever wrote it is not re-dispatched while its own
      // Workflow is still starting. A retried row's original `createdAt` is by definition old, so
      // leaving it would give the row *zero* grace: the next cron tick would claim it and dispatch a
      // second send Workflow for a job this function had already dispatched successfully. `runSend`
      // short-circuits only on `sent`/`canceled`, so both instances would render and send, and the
      // recipient would get two copies. Re-stamping it puts the retry inside the same window a fresh
      // enqueue gets, which is exactly what a retry is.
      createdAt: SQLiteDate.encode(deps.now),
    })
    .where("id", "=", jobId)
    // Status is in the predicate, not merely checked above, which makes this a compare-and-set rather
    // than a read followed by a hopeful write. Two people pressing retry on the same visible failure is
    // the ordinary case here, and without it the loser would reset a row the winner's Workflow had
    // already claimed and then dispatch a second send of the same email.
    .where("status", "=", "failed")
    .executeTakeFirst();

  if ((updated.numUpdatedRows ?? 0n) === 0n) {
    // Somebody else re-queued it between the read and the write. Refused with the same words the state
    // check above uses, because it is the same refusal — the job is simply no longer failed.
    const current = await getJob(deps.db, jobId);
    throw new ConflictError({
      message: `Only a failed job can be retried. This one is ${current?.status ?? "no longer there"}.`,
      action: "Reload the send log — somebody may have retried it already.",
      detail: `email job '${jobId}' left the failed state between the read and the write`,
    });
  }

  let dispatched = false;
  if (deps.sender && batchId) {
    try {
      // Under the id the row now carries. The claim is written first, so the instance can never be alive
      // before the row can name it; the reverse order would leave a window in which a tick re-drives a
      // job whose Workflow has already started.
      await deps.sender.create({ id: batchId, params: { jobIds: [jobId] } });
      dispatched = true;
    } catch {
      // Swallowed deliberately: the row is `pending` naming an instance that is not there, the runtime
      // disowns it, and the every-minute scheduler owns recovery.
    }
  }

  const job = (await getJob(deps.db, jobId)) ?? existing;
  return { job, dispatched };
}
