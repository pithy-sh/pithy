// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { enqueueEmail } from "../send/enqueue";
import type { EmailMessage, EmailSender, EmailSendResult } from "../send/sender";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { runScheduler } from "./scheduler";
import { runSendBatch, type SendBatchDeps, type SendBatchStep } from "./sendBatch";

/**
 * The send batch across a resume (pithy-sh/pithy#327).
 *
 * A Workflow does not resume inside the step it died in. It re-executes this body from the top and
 * serves every completed step from the journal, so anything the body computes outside a step is computed
 * again on the newer clock. The clock here answers **two** questions, and they want opposite lifetimes:
 *
 *   - the **pass instant** dates the work — `sentAt`, the redaction stamp, and how long a tracked link
 *     stays valid — and a batch that backs off and resumes dated its remaining jobs by the resume;
 *   - the **heartbeat** is `updatedAt`, which the scheduler reads to decide a `sending` job is stranded
 *     and re-drives it after `stuckMs`. Freezing that is a live batch declared stuck, a second send
 *     Workflow started against a job the first is still working, and both of them calling `send`.
 *
 * A sweep journalled the one variable and was reverted for the second reason. Both properties are driven
 * here, over a real journal and a real scheduler tick — the double-send is the criterion that outranks
 * the other, so it is stated as a dispatch that must not happen rather than as a timestamp.
 */

const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St" };
const signing = { key: "signing-key", kid: "1" };

/** When the batch began. */
const PASS_STARTED = new Date("2026-06-18T12:00:00.000Z");
/** Twenty minutes on — past the scheduler's fifteen-minute `stuckMs`. An ordinary backoff. */
const RESUMED = new Date("2026-06-18T12:20:00.000Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A scriptable fake of the Email Service binding. */
function fakeSender(behavior: (m: EmailMessage) => EmailSendResult | Promise<EmailSendResult>): {
  sender: EmailSender;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sender: {
      async send(message) {
        sent.push(message);
        return behavior(message);
      },
    },
  };
}

function batchDeps(sender: EmailSender, clock: () => Date, overrides: Partial<SendBatchDeps> = {}): SendBatchDeps {
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender,
    theme,
    baseUrl: "https://api.acme.test",
    signing,
    linkTtlDays: 90,
    maxAttempts: 5,
    heartbeatAt: clock,
    ...overrides,
  };
}

/**
 * The Workflow journal, structurally: a completed step returns what it returned the first time, and a
 * step never reached runs. `interruptBefore` kills the batch just before a named step, once, so a second
 * call over the same journal is a genuine resume.
 */
class Interrupted extends Error {}

function journalledStep(
  journal: Map<string, unknown>,
  interruptBefore?: string,
  /** Runs just before a step that is about to execute — where a test watches the world mid-batch. */
  before?: (name: string) => Promise<void>,
): SendBatchStep {
  const runner = {
    armed: interruptBefore !== undefined,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (journal.has(name)) return journal.get(name) as T;
      if (runner.armed && name === interruptBefore) {
        runner.armed = false;
        throw new Interrupted(`the batch died before ${name}`);
      }
      await before?.(name);
      const result = await fn();
      journal.set(name, result);
      return result;
    },
  };
  return runner;
}

async function enqueue(to: string, idSeed: string, clickTracking = false): Promise<string> {
  const result = await enqueueEmail(
    {
      db: emailDatabase(env.DB),
      fromAddress: "noreply@pithy.sh",
      fromName: "Acme",
      theme,
      now: PASS_STARTED,
      newId: () => idSeed,
    },
    {
      to,
      template: "magicLink",
      payload: { url: "https://acme.test/s", expiresMinutes: 15 },
      clickTracking,
    },
  );
  return result.jobId;
}

/**
 * Claim a job the way the scheduler's fan-out does before it dispatches a batch: `sending`, stamped
 * with the instant of the claim. Every job a send Workflow is handed arrives in this state, so a test
 * that left them `pending` would be asking the scheduler a different question than production does.
 */
async function claim(jobId: string, at: Date): Promise<void> {
  await env.DB.prepare("update pithy_email_jobs set status = 'sending', updated_at = ? where id = ?")
    .bind(at.getTime(), jobId)
    .run();
}

/** One scheduler tick, with the defaults the email worker ships. Returns the batches it dispatched. */
async function tick(at: Date): Promise<string[][]> {
  const dispatched: string[][] = [];
  await runScheduler({
    db: emailDatabase(env.DB),
    now: at,
    graceMs: 2 * MINUTE_MS,
    stuckMs: 15 * MINUTE_MS,
    batchSize: 50,
    maxJobs: 500,
    dispatch: async (jobIds) => {
      dispatched.push(jobIds);
    },
  });
  return dispatched;
}

/** The `exp` claim of the tracked link in a sent message, as a `Date`. */
function linkExpiry(message: EmailMessage): Date {
  const match = /_pithy\/email\/c\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(message.html ?? "");
  if (!match?.[1]) throw new Error(`no tracked link in the message: ${message.html?.slice(0, 200)}`);
  const payload = match[1].split(".")[0] as string;
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return new Date((JSON.parse(json) as { exp: number }).exp * 1000);
}

async function jobRow(jobId: string): Promise<{ status: string; updated_at: number; sent_at: number | null }> {
  const row = await env.DB.prepare("select status, updated_at, sent_at from pithy_email_jobs where id = ?")
    .bind(jobId)
    .first<{ status: string; updated_at: number; sent_at: number | null }>();
  if (!row) throw new Error(`no job ${jobId}`);
  return row;
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("runSendBatch — the pass instant", () => {
  test("a resumed batch dates its remaining jobs by the pass, not by the resume", async () => {
    const first = await enqueue("ada@example.com", "job-1");
    const second = await enqueue("bob@example.com", "job-2");
    await claim(first, PASS_STARTED);
    await claim(second, PASS_STARTED);

    let clock = PASS_STARTED;
    const { sender } = fakeSender(() => ({ messageId: "msg" }));
    const deps = batchDeps(sender, () => clock);
    const journal = new Map<string, unknown>();

    await expect(runSendBatch(deps, journalledStep(journal, `send-${second}`), [first, second])).rejects.toBeInstanceOf(
      Interrupted,
    );
    expect((await jobRow(first)).sent_at).toBe(PASS_STARTED.getTime());

    // The body re-executes on the newer clock. That is the platform, not the test being clever.
    clock = RESUMED;
    await runSendBatch(deps, journalledStep(journal), [first, second]);

    // The instant the pass began, not the instant it came back — the same rule for both halves of it.
    expect((await jobRow(second)).sent_at).toBe(PASS_STARTED.getTime());
  });

  test("and a link minted on the resumed half expires from the pass too", async () => {
    // The expiry a recipient is promised is a property of the batch, not of which attempt happened to
    // mint it. Two people in one batch being given links of different lengths is the observable version
    // of the same defect, and it is the half a `sentAt` assertion alone would miss.
    const first = await enqueue("ada@example.com", "job-1", true);
    const second = await enqueue("bob@example.com", "job-2", true);
    await claim(first, PASS_STARTED);
    await claim(second, PASS_STARTED);

    let clock = PASS_STARTED;
    const { sender, sent } = fakeSender(() => ({ messageId: "msg" }));
    const deps = batchDeps(sender, () => clock);
    const journal = new Map<string, unknown>();

    await expect(runSendBatch(deps, journalledStep(journal, `send-${second}`), [first, second])).rejects.toBeInstanceOf(
      Interrupted,
    );
    clock = RESUMED;
    await runSendBatch(deps, journalledStep(journal), [first, second]);

    expect(sent).toHaveLength(2);
    const expiries = sent.map((message) => linkExpiry(message).getTime());
    expect(expiries).toEqual([PASS_STARTED.getTime() + 90 * DAY_MS, PASS_STARTED.getTime() + 90 * DAY_MS]);
  });
});

describe("runSendBatch — the heartbeat", () => {
  /**
   * The criterion that outranks the others.
   *
   * `updatedAt` is not a stamp. It is the scheduler's evidence that a `sending` job is still being
   * worked on, and the `sending` re-drive claims anything older than `stuckMs` on the assumption its
   * dispatch died. A resumed attempt that writes the pass instant therefore reports a job it is
   * actively retrying as fifteen minutes stale — so the next tick claims it and starts a second send
   * Workflow while the first is mid-flight. `runSend` short-circuits only a job already `sent`, so both
   * render and both call `send`. One person, two emails.
   */
  test("a live batch that resumes past stuckMs is not re-driven as stranded", async () => {
    const jobId = await enqueue("ada@example.com", "job-1");
    await claim(jobId, PASS_STARTED);

    // A sender that keeps failing retryably, so the job stays `sending` and the batch keeps being
    // retried — which is the only state in which the stuck detector has anything to say.
    const { sender } = fakeSender(() => {
      throw new Error("upstream hiccup");
    });
    let clock = PASS_STARTED;
    const deps = batchDeps(sender, () => clock);
    // **One journal across both attempts**, which is what makes the second a resume rather than a second
    // instance. A fresh journal per attempt re-reads `pass-instant` on the newer clock, so the pass
    // instant and the heartbeat agree by accident and this test cannot tell them apart — it passed a
    // planted journalled heartbeat before the journal was shared.
    const journal = new Map<string, unknown>();

    await expect(runSendBatch(deps, journalledStep(journal), [jobId])).rejects.toBeDefined();
    expect((await jobRow(jobId)).status).toBe("sending");

    // The Workflow backs off and re-executes the body twenty minutes later — past `stuckMs`.
    clock = RESUMED;
    await expect(runSendBatch(deps, journalledStep(journal), [jobId])).rejects.toBeDefined();
    // The pass instant did come back from the journal — so the two clocks genuinely disagree here, and
    // the assertions below are about which one `updatedAt` took.
    expect(journal.get("pass-instant")).toBe(PASS_STARTED.getTime());

    // The criterion, first and stated as the thing that must not happen: no second send Workflow is
    // started against a job the batch is still working.
    expect(await tick(new Date(RESUMED.getTime() + MINUTE_MS))).toEqual([]);
    // And the reason it did not happen — the attempt just made wrote the heartbeat.
    expect((await jobRow(jobId)).updated_at).toBe(RESUMED.getTime());
  });

  test("and the detector still catches a batch that really did die", async () => {
    // The vacuity check on the test above. A scheduler that never re-drives anything would satisfy it
    // trivially, and the safety net it would have removed is what recovers a dispatch that never
    // started. The same row, untouched for twenty minutes, must be claimed.
    const jobId = await enqueue("ada@example.com", "job-1");
    await claim(jobId, PASS_STARTED);

    expect(await tick(new Date(RESUMED.getTime() + MINUTE_MS))).toEqual([[jobId]]);
  });
});

/**
 * The tail (pithy-sh/pithy#340).
 *
 * #327 made the *head* of a batch honest: the job in a step is patched on the heartbeat clock, so a
 * batch that resumes late is not read as stranded. It said nothing about the jobs **behind** it.
 *
 * `runScheduler` claims a whole batch up front — every id stamped with the one instant of the claim —
 * and only then dispatches one Workflow for it. The batch then walks that list one job at a time. So
 * every job it has not reached yet carries the claim instant, and nothing writes to those rows until
 * the batch arrives. A batch that takes longer to walk than `stuckMs` therefore has its own unreached
 * jobs re-driven out from under it, and a second send Workflow starts against them while the first is
 * still coming. Both drivers reach the job. Both send.
 *
 * That is the same outcome #327 exists to prevent, from a direction its fix did not cover — and it does
 * not need a resume, a crash, or a slow job to happen. It needs a queue.
 *
 * The fix is not a longer `stuckMs`: a timeout tuned to outrun a queue loses whenever the queue grows.
 * Liveness is a property of the **batch**, not of a row, so the batch says so — it renews the claim on
 * every job it still holds at the top of each send step. `updatedAt` then means what the scheduler has
 * always read it as meaning: work happened on this job's batch, recently.
 */
describe("runSendBatch — the tail", () => {
  /** Five claimed jobs, in order, all stamped with the one instant of the claim. */
  async function claimedBatch(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) ids.push(await enqueue(`user-${i}@example.com`, `job-${i}`));
    for (const id of ids) await claim(id, PASS_STARTED);
    return ids;
  }

  test("a batch still working through its queue is not re-driven at the far end of it", async () => {
    const ids = await claimedBatch(5);
    const last = ids[4] as string;

    // Six minutes a job. Nothing pathological — no crash, no resume, no backoff. By the time the batch
    // reaches its last job it has been running twenty-four minutes, and `stuckMs` is fifteen.
    let clock = PASS_STARTED;
    const { sender, sent } = fakeSender(() => {
      clock = new Date(clock.getTime() + 6 * MINUTE_MS);
      return { messageId: "msg" };
    });
    const deps = batchDeps(sender, () => clock);

    // The scheduler ticks in the gap before the last job's step — the moment the defect is visible,
    // with the batch demonstrably alive and that job claimed, `sending`, and not yet started.
    const dispatched: string[][] = [];
    const step = journalledStep(new Map<string, unknown>(), undefined, async (name) => {
      if (name === `send-${last}`) dispatched.push(...(await tick(clock)));
    });

    await runSendBatch(deps, step, ids);

    // The criterion, stated as the thing that must not happen: no second send Workflow against a job
    // this batch is on its way to.
    expect(dispatched).toEqual([]);
    // And the reason: the batch renewed the claim on what it still held. Twenty-four minutes in, the
    // untouched last job was six minutes old, not twenty-four.
    expect(sent).toHaveLength(5);
  });

  test("and a job the batch has finished is left alone, not held open by the renewal", async () => {
    // The renewal covers what the batch still holds and nothing else. A finished job kept fresh would
    // be a lie in the other direction — a `sending` row that never ages is a row the safety net can
    // never recover — so the first job's stamp must be the instant it was sent.
    const ids = await claimedBatch(3);
    let clock = PASS_STARTED;
    const { sender } = fakeSender(() => {
      clock = new Date(clock.getTime() + 6 * MINUTE_MS);
      return { messageId: "msg" };
    });

    await runSendBatch(
      batchDeps(sender, () => clock),
      journalledStep(new Map<string, unknown>()),
      ids,
    );

    expect((await jobRow(ids[0] as string)).updated_at).toBe(PASS_STARTED.getTime() + 6 * MINUTE_MS);
    expect((await jobRow(ids[1] as string)).updated_at).toBe(PASS_STARTED.getTime() + 12 * MINUTE_MS);
  });

  test("and a retry of the job in flight renews the tail too", async () => {
    // Where #327 and #340 cross. A step that fails retryably backs off and re-executes its *body*; its
    // result was never journalled, so nothing about it is served back. The renewal has to live in that
    // body, because a backoff is precisely the long gap in which a tail goes stale — and a renewal
    // written as a step of its own would be journalled on the first attempt and skipped on every retry
    // after it, which passes every test above and restores the defect on the path most likely to hit it.
    const ids = await claimedBatch(3);
    let attempts = 0;
    const { sender } = fakeSender(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("upstream hiccup");
      return { messageId: "msg" };
    });
    let clock = PASS_STARTED;
    const deps = batchDeps(sender, () => clock);
    const journal = new Map<string, unknown>();

    await expect(runSendBatch(deps, journalledStep(journal), ids)).rejects.toBeDefined();

    // The Workflow backs off twenty minutes and re-executes. The tail has not been touched since the
    // claim, and both of its jobs are `sending`.
    clock = RESUMED;
    const dispatched: string[][] = [];
    const step = journalledStep(journal, undefined, async (name) => {
      if (name === `send-${ids[1]}`) dispatched.push(...(await tick(new Date(clock.getTime() + MINUTE_MS))));
    });
    await runSendBatch(deps, step, ids);

    expect(dispatched).toEqual([]);
    expect(journal.get("pass-instant")).toBe(PASS_STARTED.getTime());
  });

  test("and a batch that dies part-way leaves its tail recoverable", async () => {
    // The vacuity check. A renewal that stamped the tail once and generously would satisfy the test
    // above and quietly delete the safety net: a dispatch that dies mid-queue must still have its
    // unreached jobs re-driven, or those emails are never sent at all.
    const ids = await claimedBatch(5);
    const { sender } = fakeSender(() => ({ messageId: "msg" }));
    const deps = batchDeps(sender, () => PASS_STARTED);

    await expect(
      runSendBatch(deps, journalledStep(new Map<string, unknown>(), `send-${ids[2]}`), ids),
    ).rejects.toBeInstanceOf(Interrupted);

    // Nothing runs for twenty minutes. The three jobs it never reached are genuinely stranded.
    expect(await tick(new Date(PASS_STARTED.getTime() + 20 * MINUTE_MS))).toEqual([ids.slice(2)]);
  });
});
