// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { renewClaim } from "../send/renewClaim";
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
 * **The batch is the unit of liveness.** The scheduler claims a whole batch up front and dispatches one
 * Workflow for it, so every job on the list is held by this body from the first step to the last — and
 * a job it has not reached is queued, not stranded. Only the batch knows that, so only the batch can
 * say it: each step renews the claim on the jobs behind it (pithy-sh/pithy#340).
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
   * `runSend` as a thunk, because `updatedAt` is the scheduler's evidence that a `sending` job is still
   * being worked on and a frozen one is a live batch declared stuck — a second send Workflow against a
   * job the first is mid-flight on, which is a double-send. That is the criterion that outranks the
   * others here, and it is why this is one journalled read rather than a journalled clock.
   *
   * Epoch milliseconds rather than a `Date`, because a journal round-trips JSON: a `Date` would come back
   * a string on the resume and an object on the first pass.
   */
  const passStartedAtMs: number = await step.do("pass-instant", async () => deps.heartbeatAt().getTime());
  const sendDeps: SendDeps = { ...deps, passStartedAt: new Date(passStartedAtMs) };
  // Counted rather than walked with `jobIds.entries()`, which the determinism gate refuses: a nullary
  // call on a parameter is how a driver reaches a seam, and that walk cannot tell this array of data
  // from an injected clock. `slice` below takes an argument, so it was never in question. The counter
  // says the same thing and asks the gate to make no exception — see `cli/src/ci/workflowDrivers.ts`.
  let index = 0;
  for (const jobId of jobIds) {
    /**
     * The jobs behind this one — claimed, `sending`, not yet started (pithy-sh/pithy#340).
     *
     * They are held by this batch and nothing writes to them until it arrives, so without this they
     * carry the claim instant until then and a batch that takes longer to walk than `stuckMs` has its
     * own queue re-driven out from under it. See {@link renewClaim}.
     */
    const tail = jobIds.slice(index + 1);
    index += 1;
    await step.do(`send-${jobId}`, async () => {
      // Inside the step, not around it, and deliberately not a step of its own. A step's *result* is
      // journalled, its body is not — so this runs on every attempt of this job and never comes back
      // from the journal. A resume renews the tail the moment it does real work again, and a step
      // backing off between retries renews it on each attempt, which is exactly as often as the job in
      // flight writes its own row. No job in a batch is then staler than the attempt currently running.
      if (tail.length > 0) await renewClaim(deps.db, tail, deps.heartbeatAt());
      await runSend(sendDeps, jobId);
    });
  }
}
