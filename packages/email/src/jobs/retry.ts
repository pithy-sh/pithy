// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailJob } from "../data/emailJob";
import type { EmailDatabase, EmailSuppressionDatabase } from "../data/tables";
import { EmailSuppressedError } from "../error/errors";
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
 * - `sent` — already delivered. Retrying is a duplicate email to a real person.
 * - `pending` / `scheduled` / `sending` — still in flight. Resetting it races the scheduler, and
 *   `sending` in particular is a job a Workflow is holding right now.
 * - `suppressed` — the address is on the block list. Retrying is the one send this capability must
 *   never make.
 * - `bounced` — the recipient's server said permanently no, and the bounce handler only sets this
 *   state while suppressing the address, so a retry is the previous case wearing a different label.
 * - `cancelled` — somebody withdrew it. Reviving a withdrawal is a separate decision, not a retry, and
 *   it should have to be made somewhere it is named.
 *
 * ## The attempt budget is reset, and it has to be
 *
 * `runSend` gives up when `attempts >= maxAttempts`. A job that failed did so having spent its budget,
 * so a retry that left `attempts` alone would take one retryable error to fail terminally again — the
 * button would appear to work and change nothing. `attempts` returns to zero; `error` does not, because
 * it is the record of what went wrong last time and a successful send clears it anyway.
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

  const updated = await deps.db
    .updateTable("pithyEmailJobs")
    .set({
      // `pending`, whatever the original mode was. A retry is an operator asking for this to go now;
      // re-arming a `scheduled` job to a `sendAt` that is already in the past would say the same thing
      // less clearly, and re-deriving a `timezone` job's local slot would move the send to tomorrow.
      status: "pending",
      sendAt: SQLiteDate.encode(deps.now),
      attempts: 0,
      updatedAt: SQLiteDate.encode(deps.now),
      // **`createdAt` is reset too, and it is load-bearing.** The scheduler's safety net for an
      // immediate job is `status = 'pending' AND createdAt <= now - graceMs`, and that grace exists so a
      // job that has just been dispatched by whoever wrote it is not re-dispatched while its own
      // Workflow is still starting. A retried row's original `createdAt` is by definition old, so
      // leaving it would give the row *zero* grace: the next cron tick would claim it and dispatch a
      // second send Workflow for a job this function had already dispatched successfully. `runSend`
      // short-circuits only on `sent`/`cancelled`, so both instances would render and send, and the
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
  if (deps.sender) {
    try {
      await deps.sender.create({ params: { jobIds: [jobId] } });
      dispatched = true;
    } catch {
      // Swallowed deliberately: the row is `pending`, and the every-minute scheduler owns recovery.
    }
  }

  const job = (await getJob(deps.db, jobId)) ?? existing;
  return { job, dispatched };
}
