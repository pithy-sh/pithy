// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { runSend, type SendDeps, type SendOutcome } from "../send/runSend";

/**
 * The send batch — the body `EmailSendWorkflow.run` hands its step runner to.
 *
 * **Why it is here and not in the Workflow class.** `worker.ts` imports `cloudflare:workers`, which
 * resolves in workerd and nowhere else, so anything inside it can only be exercised by deploying it.
 * Every property worth proving about this body is a property of a *resume* — a Workflow does not resume
 * inside the step it died in, it re-executes this function from the top and serves every completed step
 * from the journal — and the only way to know a resume behaves is to drive one.
 *
 * **One step per job.** Each is independently retried and backed off by the Workflow runtime, and a step
 * whose retries are spent is contained here, so a single bad recipient never blocks the rest of the
 * batch. That sentence has been in this docblock since the file was written and the code did not do it
 * until #380: the throw came out of the loop and took every job behind it, on this attempt and on every
 * replay of the body.
 *
 * **The batch is the unit of liveness, and it says so by existing.** The scheduler claims a whole batch
 * up front, stamps every row with the batch's id — which is this Workflow instance's id — and dispatches
 * one instance for it. So a job this body has not reached is queued, not stranded, and the scheduler
 * establishes that by asking the runtime whether the instance is still running.
 *
 * That is why nothing here writes to a job it is not sending. The previous answer had each step renew the
 * claim on every job behind it (pithy-sh/pithy#340), which is correct and costs N(N-1)/2 row updates for
 * a batch of N — 1,225 at the shipped batch size of 50, on a setting with no ceiling — and still could
 * not speak for a step waiting out its retry backoff, because a body that is not running renews nothing
 * (pithy-sh/pithy#342). One question to the runtime answers both, and writes nothing.
 */

/** The durable step runner, structurally. Injected, so a test can drive an interrupt and a resume. */
export interface SendBatchStep {
  /** Run a named step, or return its journalled result if this instance already completed it. */
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * What a batch needs: everything one send needs, minus the pass instant it journals for itself.
 *
 * `heartbeatAt` is the clock, and it stays a thunk all the way down — `runSend` reads it afresh on every
 * patch. The pass instant is *one journalled read of the same clock*, which is the whole design in a
 * sentence: one source, two lifetimes, and neither of them able to answer for the other.
 */
export type SendBatchDeps = Omit<SendDeps, "passStartedAt">;

/**
 * One job's place in the batch — **two states, and the outcome lives behind the one that has it**
 * (#380).
 *
 * A step exhausts its retries and throws, and the docblock above promises that never blocks the rest of
 * the batch. It did not: the throw propagated out of the loop and every job behind it went unsent, on
 * this attempt and on every retry of the body, because a re-execution replays the journal and reaches
 * the same failing step again. A batch of fifty lost forty-seven messages to one bad recipient.
 *
 * The two states share no field, so a caller cannot reach an outcome without narrowing, and a job the
 * batch could not finish cannot be read as one that was skipped for a reason `runSend` names. What
 * happens to that job next is the scheduler's: its row is still `sending` or `failed`, and the
 * `stuckMs` re-drive is what picks it up.
 */
export type BatchJobResult =
  | {
      /** The send ran to a conclusion — sent, suppressed, cancelled or terminally failed. */
      state: "attempted";
      /** The job this is about. */
      jobId: string;
      /** What the send concluded. Present here alone. */
      outcome: SendOutcome;
    }
  | {
      /**
       * The step did not finish: it threw, and its retries within this instance are spent. Nothing is
       * claimed about the job beyond that — it may have been rendered, it may have been sent and the
       * write lost.
       */
      state: "unfinished";
      /** The job this is about — the only fact this state carries. */
      jobId: string;
    };

/**
 * What one batch did, one entry per job in dispatch order.
 *
 * Returned rather than logged because this capability has no logger seam and a Workflow's return value
 * *is* its instance output — so the record lands where an operator already looks when a batch is in
 * question, next to the step journal that shows which step failed.
 */
export interface BatchSendReport {
  /** One entry per job id the batch was dispatched with, in that order. */
  jobs: BatchJobResult[];
}

/** Send one batch of jobs, one durable step each. */
export async function runSendBatch(
  deps: SendBatchDeps,
  step: SendBatchStep,
  jobIds: readonly string[],
): Promise<BatchSendReport> {
  /**
   * The pass instant, journalled (pithy-sh/pithy#327).
   *
   * One read of `heartbeatAt`, taken inside a step so a resume reads back the instant the batch began
   * rather than the instant it came back. It dates the work — `sentAt`, the redaction stamp, the events,
   * and every tracked link's expiry.
   *
   * **What is deliberately not journalled is the clock itself.** `deps.heartbeatAt` goes through to
   * `runSend` as a thunk, because `updatedAt` is what decides a `sending` job is old enough to ask about
   * at all, and a frozen one puts a job the batch is mid-flight on in front of that question every tick.
   * The batch's own liveness answers it correctly either way; a clock that lies is still a clock that
   * lies, and `sentAt` is not the only thing reading this.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON: a `Date` would come back
   * a string on the resume and an object on the first pass.
   */
  const passStartedAtMs: number = await step.do("pass-instant", async () => deps.heartbeatAt().getTime());
  const sendDeps: SendDeps = { ...deps, passStartedAt: new Date(passStartedAtMs) };
  const jobs: BatchJobResult[] = [];
  for (const jobId of jobIds) {
    // Contained per job, which is what the docblock above has always claimed (#380). A step that has
    // spent its retries throws, and the throw used to end the batch — so one recipient whose template
    // will not render, or whose row was deleted mid-flight, cost every job behind it its send.
    //
    // `try`/`catch` rather than `.catch()`: `step.do` is handed a function, and a runner that throws
    // before it returns a promise is not a rejected promise (#371).
    //
    // **The guard takes no binding.** What a send throws carries a recipient's address, a provider's
    // response, and sometimes the rendered link itself — none of which may travel into a value the
    // Workflow instance publishes as its output. The job id is the actionable fact and it is already
    // here. The failure itself stays exactly where it is visible and belongs: the failed step in the
    // instance's own journal.
    //
    // **The step runner is not one of the contributors, and `began` is what tells them apart.** A send
    // that ran and failed is this job's failure and is contained. A runner that will not start the step
    // at all is the durable mechanism itself refusing — an instance being torn down — and there is no
    // batch left to carry on: every job behind would fail identically, and a body that keeps calling a
    // runner which has refused is a body that has not noticed it is being killed. So that one is
    // rethrown, exactly as `readProjectLedger` still throws when the databases cannot be enumerated.
    let began = false;
    try {
      const outcome = await step.do(`send-${jobId}`, async () => {
        began = true;
        return await runSend(sendDeps, jobId);
      });
      jobs.push({ state: "attempted", jobId, outcome });
    } catch (interrupted) {
      // The binding exists only to rethrow the same object, unchanged. Nothing derived from it reaches
      // the report — that is what `unfinished` carrying only a job id means.
      if (!began) throw interrupted;
      jobs.push({ state: "unfinished", jobId });
    }
  }
  return { jobs };
}
