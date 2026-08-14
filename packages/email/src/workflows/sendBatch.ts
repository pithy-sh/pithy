// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { runSend, type SendDeps } from "../send/runSend";

/**
 * The send batch — the body `EmailSendWorkflow.run` hands its step runner to.
 *
 * **Why it is here and not in the Workflow class.** `worker.ts` imports `cloudflare:workers`, which
 * resolves in workerd and nowhere else, so anything inside it can only be exercised by deploying it.
 * Every property worth proving about this body is a property of a *resume* — a Workflow does not resume
 * inside the step it died in, it re-executes this function from the top and serves every completed step
 * from the journal — and the only way to know a resume behaves is to drive one.
 *
 * **One step per job.** Each is independently retried and backed off by the Workflow runtime, so a
 * single bad recipient never blocks the rest of the batch.
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

/** Send one batch of jobs, one durable step each. */
export async function runSendBatch(deps: SendBatchDeps, step: SendBatchStep, jobIds: readonly string[]): Promise<void> {
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
  for (const jobId of jobIds) {
    await step.do(`send-${jobId}`, async () => {
      await runSend(sendDeps, jobId);
    });
  }
}
