// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { retryJob } from "../jobs/retry";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { isLiveInstanceStatus } from "../workflows/instanceLiveness";
import { runScheduler } from "../workflows/scheduler";
import { runSendBatch, type SendBatchStep } from "../workflows/sendBatch";
import { type EnqueueResult, enqueueEmail } from "./enqueue";
import type { EmailSender } from "./sender";

/**
 * Batch identity, end to end (pithy-sh/pithy#342).
 *
 * `runScheduler`'s veto is only as good as the id it reads: it holds a stale-looking row when the
 * runtime says the instance the row names is alive. `scheduler.workers.test.ts` proves the veto over a
 * stub. This proves the thing the stub assumes — that the id on the row belongs to *the instance coming
 * for that row* — for the two dispatchers that are not the scheduler.
 *
 * Both were wrong, in opposite directions, and both are driven here rather than asserted:
 *
 *   - `enqueueEmail` minted no id at all, so every immediate send was born stranded and the first
 *     retryable failure was a double-send.
 *   - `retryJob` left the failed batch's id on the row, which is the one id guaranteed to belong to
 *     somebody else — and usually to a batch that is still running.
 *
 * The criterion that outranks everything here is that **no path may double-send**, and it is stated
 * throughout as a dispatch that must not happen. Every such test is paired with its vacuity check: the
 * same drive with the batch genuinely dead, where the row must be recovered. A veto that could not be
 * withdrawn would satisfy the first half of this file and silently delete the safety net.
 */

const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St" };
const signing = { key: "signing-key", kid: "1" };

/** When the work began. */
const STARTED = new Date("2026-06-18T12:00:00.000Z");
const MINUTE_MS = 60_000;
/** Twenty minutes on — past the scheduler's fifteen-minute `stuckMs` and its two-minute grace. */
const LATER = new Date(STARTED.getTime() + 20 * MINUTE_MS);

/**
 * The Workflows runtime, structurally — as a **binding**, not as a status table.
 *
 * `create` and `get` are the two calls `worker.ts` makes, with the platform's behavior on each: an
 * instance is created under the id it was given, and `get` on an id nothing was created under *rejects*.
 * That rejection is the case the whole safety net rests on, so a fake that returned "no such status"
 * instead would be answering a friendlier question than production asks.
 */
class Workflows {
  private readonly statuses = new Map<string, string>();
  /** Every dispatch made against this binding, in order, with the id it asked for. */
  readonly created: { id?: string; jobIds: string[] }[] = [];
  /** Set to throw the next `create` — a dispatch that failed. */
  failNextCreate: "before" | "after" | undefined;
  /** Runs inside `create`, before the instance exists — where a test watches the row mid-dispatch. */
  onCreate?: () => Promise<void>;

  readonly binding = {
    create: async (options: { id?: string; params: { jobIds: string[] } }): Promise<unknown> => {
      this.created.push({ id: options.id, jobIds: options.params.jobIds });
      await this.onCreate?.();
      const failure = this.failNextCreate;
      this.failNextCreate = undefined;
      // "before" is a dispatch that never landed. "after" is the nastier one: the instance exists and
      // the *answer* went missing, so the caller sees a failure and the runtime has a live Workflow.
      if (failure === "before") throw new Error("dispatch failed");
      this.statuses.set(options.id ?? `platform-${this.created.length}`, "queued");
      if (failure === "after") throw new Error("dispatch answered late");
      return {};
    },
    get: async (id: string): Promise<{ status(): Promise<{ status: string }> }> => {
      const status = this.statuses.get(id);
      // What the platform does for an id nothing was created under.
      if (status === undefined) throw new Error(`no instance ${id}`);
      return { status: async () => ({ status }) };
    },
  };

  /** Its body is executing. */
  readonly running = (batchId: string): void => void this.statuses.set(batchId, "running");
  /** The runtime spent the last retry, or the instance was terminated. Nothing more will run. */
  readonly gaveUp = (batchId: string): void => void this.statuses.set(batchId, "errored");
}

/**
 * One scheduler tick with the defaults the email worker ships, over a real Workflows fake.
 *
 * `batchIsAlive` is `worker.ts`'s three lines, kept identical on purpose — the `get`, the status, the
 * `isLiveInstanceStatus`, and the `catch` that reads any refusal as dead. That module imports
 * `cloudflare:workers` and cannot be loaded here, which is the one fidelity gap in this file: the wiring
 * is copied rather than exercised.
 */
async function tick(at: Date, workflows: Workflows): Promise<string[][]> {
  const dispatched: string[][] = [];
  await runScheduler({
    db: emailDatabase(env.DB),
    now: at,
    graceMs: 2 * MINUTE_MS,
    stuckMs: 15 * MINUTE_MS,
    batchSize: 50,
    maxJobs: 500,
    newBatchId: () => `redrive-${dispatched.length + 1}`,
    batchIsAlive: async (batchId) => {
      try {
        const instance = await workflows.binding.get(batchId);
        const { status } = await instance.status();
        return isLiveInstanceStatus(status);
      } catch {
        return false;
      }
    },
    dispatch: async (batchId, jobIds) => {
      await workflows.binding.create({ id: batchId, params: { jobIds } });
      dispatched.push(jobIds);
    },
  });
  return dispatched;
}

/**
 * The rendered subject a result now carries (pithy-sh/pithy#443), matched as `expect.any(String)` in the
 * two whole-object comparisons below.
 *
 * A literal would work and is the wrong instrument: it would pin the kit's English `email/magic_link.subject`
 * here, so a copy edit would turn this file red and send whoever ran it looking for a batching bug. This file
 * claims a dispatcher's presence or absence reaches the caller and the row alike; the subject's own contract
 * is pinned in `enqueue.workers.test.ts`, against the stored value rather than against any wording. So the
 * comparison stays a whole-object comparison and nothing about the sentence is asserted.
 */
const ANY_SUBJECT = expect.any(String);

/** What the caller is handed back — the half of the claim that is not in the row. */
type EnqueueOptions = { workflows?: Workflows; batchId?: string; mode?: "immediate" | "scheduled"; at?: Date };

/** Enqueue one immediate magic link, dispatching against `workflows` when one is given. */
async function enqueueResult(opts: EnqueueOptions = {}): Promise<EnqueueResult> {
  return await enqueueEmail(
    {
      db: emailDatabase(env.DB),
      fromAddress: "noreply@pithy.sh",
      fromName: "Acme",
      theme,
      sender: opts.workflows?.binding,
      now: opts.at ?? STARTED,
      newId: () => "job-1",
      newBatchId: () => opts.batchId ?? "enqueue-batch",
    },
    {
      to: "ada@example.com",
      template: "magicLink",
      payload: { url: "https://acme.test/s", expiresMinutes: 15 },
      ...(opts.mode === "scheduled"
        ? { mode: "scheduled" as const, sendAt: new Date(STARTED.getTime() + 60 * MINUTE_MS) }
        : {}),
    },
  );
}

/** The same enqueue, keeping only the job id — what most of this file is about. */
async function enqueue(opts: EnqueueOptions = {}): Promise<string> {
  return (await enqueueResult(opts)).jobId;
}

/** A sender that always fails retryably — the state a step in backoff leaves the row in. */
const failingSender: EmailSender = {
  async send() {
    throw new Error("upstream hiccup");
  },
};

/** The Workflow journal, structurally: a completed step is served from it, so a re-run is a resume. */
function journalledStep(journal: Map<string, unknown>): SendBatchStep {
  return {
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (journal.has(name)) return journal.get(name) as T;
      const result = await fn();
      journal.set(name, result);
      return result;
    },
  };
}

/**
 * Drive the send batch for one job with a sender that keeps failing, leaving it `sending` in backoff.
 *
 * The batch **completes** rather than rejecting: since #380 a step whose retries are spent is contained
 * so the rest of the batch still sends, and that job is reported `unfinished`. What this helper is for
 * is unchanged — the row is left `sending`, stamped with its batch, for the scheduler to find.
 */
async function backOff(jobId: string): Promise<void> {
  const report = await runSendBatch(
    {
      db: emailDatabase(env.DB),
      suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      sender: failingSender,
      theme,
      baseUrl: "https://api.acme.test",
      signing,
      linkTtlDays: 90,
      maxAttempts: 5,
      heartbeatAt: () => STARTED,
    },
    journalledStep(new Map<string, unknown>()),
    [jobId],
  );
  expect(report.jobs.map((job) => job.state)).toEqual(["unfinished"]);
}

async function rowOf(jobId: string): Promise<{ status: string; batch_id: string | null }> {
  const row = await env.DB.prepare("select status, batch_id from pithy_email_jobs where id = ?")
    .bind(jobId)
    .first<{ status: string; batch_id: string | null }>();
  if (!row) throw new Error(`no job ${jobId}`);
  return row;
}

/** Put a job in the state an operator retries from: `failed`, still naming the batch that failed it. */
async function markFailed(jobId: string, batchId: string): Promise<void> {
  await env.DB.prepare("update pithy_email_jobs set status = 'failed', attempts = 5, batch_id = ? where id = ?")
    .bind(batchId, jobId)
    .run();
}

async function retry(jobId: string, opts: { workflows?: Workflows; batchId?: string; at?: Date }): Promise<void> {
  await retryJob(
    {
      db: emailDatabase(env.DB),
      suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      sender: opts.workflows?.binding,
      now: opts.at ?? STARTED,
      newBatchId: () => opts.batchId ?? "retry-batch",
    },
    jobId,
  );
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("enqueueEmail names the batch it starts", () => {
  test("an immediate send is claimed before its Workflow exists, under the id that Workflow gets", async () => {
    const workflows = new Workflows();
    // The order is the guarantee, not an implementation detail: written first, so the runtime can never
    // hold a live instance the row cannot name. Read from inside `create`, which is the only place the
    // two orderings look different.
    let claimedDuringCreate: string | null | undefined;
    workflows.onCreate = async () => {
      claimedDuringCreate = (await rowOf("job-1")).batch_id;
    };

    const jobId = await enqueue({ workflows });

    expect(claimedDuringCreate).toBe("enqueue-batch");
    expect(workflows.created).toEqual([{ id: "enqueue-batch", jobIds: [jobId] }]);
    expect(await rowOf(jobId)).toEqual({ status: "pending", batch_id: "enqueue-batch" });
  });

  test("a job nothing is coming for names no batch", async () => {
    // Null is not "unknown", it is "nobody is on their way" — which is what makes the scheduler's
    // re-drive of an unclaimed row correct. A scheduled job and an enqueue with no binding are both
    // that, and stamping either would hold the row against an instance that was never created.
    const scheduled = await enqueue({ workflows: new Workflows(), mode: "scheduled" });
    expect(await rowOf(scheduled)).toEqual({ status: "scheduled", batch_id: null });

    await env.DB.prepare("delete from pithy_email_jobs").run();
    const unbound = await enqueue({});
    expect(await rowOf(unbound)).toEqual({ status: "undispatched", batch_id: null });
  });
});

/**
 * A dispatcher that is missing and a dispatcher that threw are two different facts, and until #410 the
 * row said the same thing about both (pithy-sh/pithy#410).
 *
 * The swallow below the `create` is right *because* the scheduler re-drives a stranded `pending` row a
 * minute later. That safety net is the every-minute cron on the host worker. Where no dispatcher was
 * composed at all, there is no host worker either — so `pending` was not deferral, it was a promise
 * nothing in the deployment could keep, and a caller was told "on its way" about mail that would never
 * move. `undispatched` says the true thing instead, in the row and in the result.
 *
 * It is a truthful status, not a grave. The day the host is deployed its first tick claims those rows,
 * because a tick running at all is the host existing — so the caller was told the truth and the mail
 * still goes.
 *
 * The two halves are driven separately here on purpose: one change that made an absent dispatcher
 * honest could as easily have made a *failed* dispatch terminal, and that would delete the safety net
 * this whole file exists to protect.
 */
describe("an absent dispatcher and a failing one are different facts", () => {
  test("with nothing to dispatch on, the row and the result both say nobody is coming", async () => {
    const result = await enqueueResult({});

    expect(result).toEqual({ jobId: "job-1", status: "undispatched", subject: ANY_SUBJECT });
    expect(await rowOf("job-1")).toEqual({ status: "undispatched", batch_id: null });
    // **And it is still recoverable.** The status is the truth at enqueue time — nobody is coming for
    // it, and a caller rendering "check your inbox" off it is reporting a delivery that cannot happen.
    // It is not a terminal state: a tick is the host's every-minute cron, so a tick running at all
    // means the host the composition was missing now exists, and the row is the backlog it drains.
    // Without this the mail enqueued before `pithy email provision` would be unsendable forever —
    // `retryJob` takes `failed` rows, and no command moves this one.
    expect(await tick(LATER, new Workflows())).toEqual([["job-1"]]);
  });

  test("with a dispatcher present and its create throwing, everything is exactly as it was", async () => {
    const workflows = new Workflows();
    workflows.failNextCreate = "before";

    const result = await enqueueResult({ workflows });

    // The safety net is real here — the host worker exists, its cron runs — so the row waits for it.
    expect(result).toEqual({ jobId: "job-1", status: "pending", subject: ANY_SUBJECT });
    expect(await rowOf("job-1")).toEqual({ status: "pending", batch_id: "enqueue-batch" });
    expect(await tick(LATER, workflows)).toEqual([["job-1"]]);
  });
});

describe("an immediate send in retry backoff is not re-driven", () => {
  /**
   * The double-send the batch-id work was supposed to close, on the path it never reached.
   *
   * Nothing pathological happens here. The Email Service refuses once, `runSend` throws so the step backs
   * off, and a backoff writes nothing — so twenty minutes later the row is `sending`, untouched, and
   * indistinguishable by timestamp from a dispatch that died. The instance is alive the whole time.
   */
  test("while its batch is alive", async () => {
    const workflows = new Workflows();
    const jobId = await enqueue({ workflows });
    workflows.running("enqueue-batch");
    await backOff(jobId);
    expect((await rowOf(jobId)).status).toBe("sending");

    // The criterion, as the thing that must not happen: no second Workflow behind a job the first is
    // still working.
    expect(await tick(LATER, workflows)).toEqual([]);
  });

  test("and recovered the moment it is not", async () => {
    // The vacuity check, one line apart from the test above. A veto that could not be withdrawn would
    // satisfy that one and never send this email at all.
    const workflows = new Workflows();
    const jobId = await enqueue({ workflows });
    workflows.running("enqueue-batch");
    await backOff(jobId);
    workflows.gaveUp("enqueue-batch");

    expect(await tick(LATER, workflows)).toEqual([[jobId]]);
  });

  test("and a dispatch whose answer went missing still counts as alive", async () => {
    // Why the claim is written before the `create` rather than after it. The instance exists, the caller
    // saw a failure and swallowed it, and the row is the only thing that can say a Workflow is coming.
    // Stamped after a successful create, this row would name nobody and be re-driven into a double-send.
    const workflows = new Workflows();
    workflows.failNextCreate = "after";
    await enqueue({ workflows });
    workflows.running("enqueue-batch");

    expect(await tick(LATER, workflows)).toEqual([]);
  });

  test("and a dispatch that never landed is re-driven exactly as it was before batch ids existed", async () => {
    // The other half of the same swallow, and the guarantee it must not cost: a failed dispatch never
    // loses an email. The row names an instance the runtime has never heard of, `get` rejects, and the
    // safety net does what it always did.
    const workflows = new Workflows();
    workflows.failNextCreate = "before";
    const jobId = await enqueue({ workflows });

    expect(await tick(LATER, workflows)).toEqual([[jobId]]);
  });
});

describe("a retry does not inherit the batch that failed it", () => {
  /**
   * The failed batch is the one Workflow guaranteed not to be coming for this row — and, because a batch
   * of fifty that failed job seven walks on to job fifty, the one most likely to still be running.
   *
   * The two tests below are the same setup with the two instances' fates swapped, and that is deliberate:
   * with the old id left on the row, each of them fails in a different direction. Keeping it is not one
   * bug with two symptoms — it is a veto pointed at the wrong Workflow, and a wrong veto is wrong both
   * when it fires and when it does not.
   */
  test("so a live one cannot hold the retry back — the retry's own batch answers for it", async () => {
    const workflows = new Workflows();
    const jobId = await enqueue({});
    await markFailed(jobId, "failed-batch");
    // The batch that failed this job is still walking the rest of its queue.
    workflows.running("failed-batch");

    await retry(jobId, { workflows });

    expect(await rowOf(jobId)).toEqual({ status: "pending", batch_id: "retry-batch" });
    expect(workflows.created).toEqual([{ id: "retry-batch", jobIds: [jobId] }]);

    // The retry's own Workflow died. Nothing is coming for the row, so it must be recovered — and would
    // not be if the veto were still asking about `failed-batch`, which is alive and holding a job it has
    // long since given up on.
    workflows.gaveUp("retry-batch");
    expect(await tick(LATER, workflows)).toEqual([[jobId]]);
  });

  test("and a dead one cannot re-drive it into a second send", async () => {
    const workflows = new Workflows();
    const jobId = await enqueue({});
    await markFailed(jobId, "failed-batch");
    // This time the batch that failed the job is over. A row still naming it reads as stranded.
    workflows.gaveUp("failed-batch");

    await retry(jobId, { workflows });
    workflows.running("retry-batch");
    // The retry's Workflow backs off on a refusal, exactly like any other send, and writes nothing.
    await backOff(jobId);

    // The criterion: no second Workflow behind the one the retry started.
    expect(await tick(LATER, workflows)).toEqual([]);
  });

  test("and with no binding to dispatch on, the row names nobody rather than the batch that gave up", async () => {
    // The `sender`-less path resets the row and leaves the scheduler to claim it. Leaving the old id
    // here would be the same lie without even a Workflow behind it: the next tick would ask about a
    // batch that has nothing to do with this row and, while it happened to be alive, hold the job.
    //
    // The status is `undispatched`, which is what `enqueueEmail` writes for the very same env: one
    // deployment, one word for "this composition binds no send Workflow". It is claimed by the tick
    // exactly as a `pending` row is, so the retry is deferred rather than dropped.
    const workflows = new Workflows();
    const jobId = await enqueue({});
    await markFailed(jobId, "failed-batch");
    workflows.running("failed-batch");

    await retry(jobId, {});

    expect(await rowOf(jobId)).toEqual({ status: "undispatched", batch_id: null });
    expect(await tick(LATER, workflows)).toEqual([[jobId]]);
  });
});
