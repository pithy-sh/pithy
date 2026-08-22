// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { enqueueEmail } from "../send/enqueue";
import type { EmailMessage, EmailSender, EmailSendResult } from "../send/sender";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { isLiveInstanceStatus } from "./instanceLiveness";
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
 * A sweep journaled the one variable and was reverted for the second reason. Both properties are driven
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
 * The Workflows runtime, structurally: the instances a dispatch created and what it would say about
 * each of them (pithy-sh/pithy#342).
 *
 * The point of the fake is that nothing here decides liveness for the scheduler. An instance is created
 * and then run, and the *drive* moves it: a body that throws leaves it exactly where it was — `running`,
 * with a retry pending — which is what a step in backoff is, and the state the whole defect lives in.
 * `gaveUp` is the runtime spending the last retry, after which nothing more will run.
 *
 * The status strings are the platform's own, and they are read through `isLiveInstanceStatus` — the same
 * predicate `worker.ts` reads them through. A fake with its own idea of which states count as alive
 * would prove the mapping in the test rather than the one that ships.
 */
class Workflows {
  private readonly statuses = new Map<string, string>();

  /** A batch was dispatched: the instance now exists and is queued to run. */
  readonly created = (batchId: string): void => void this.statuses.set(batchId, "queued");
  /** Its body is executing. */
  readonly running = (batchId: string): void => void this.statuses.set(batchId, "running");
  /** The runtime spent the last retry, or the instance was terminated. Nothing more will run. */
  readonly gaveUp = (batchId: string): void => void this.statuses.set(batchId, "errored");

  /** What `worker.ts` hands the scheduler, over this instance table instead of over the binding. */
  readonly isAlive = async (batchId: string): Promise<boolean> => {
    const status = this.statuses.get(batchId);
    return status !== undefined && isLiveInstanceStatus(status);
  };
}

/**
 * Claim a batch the way the scheduler's fan-out does before it dispatches it: every job `sending`,
 * stamped with the one instant of the claim and with the batch's id — which is the id of the send
 * Workflow instance about to be created for it. Every job a send Workflow is handed arrives in this
 * state, so a test that left them `pending`, or unclaimed by any batch, would be asking the scheduler a
 * different question than production does.
 */
async function claimBatch(workflows: Workflows, batchId: string, jobIds: readonly string[], at: Date): Promise<void> {
  for (const jobId of jobIds) {
    await env.DB.prepare("update pithy_email_jobs set status = 'sending', updated_at = ?, batch_id = ? where id = ?")
      .bind(at.getTime(), batchId, jobId)
      .run();
  }
  workflows.created(batchId);
  workflows.running(batchId);
}

/** One scheduler tick, with the defaults the email worker ships. Returns the batches it dispatched. */
async function tick(at: Date, workflows: Workflows = new Workflows()): Promise<string[][]> {
  const dispatched: string[][] = [];
  await runScheduler({
    db: emailDatabase(env.DB),
    now: at,
    graceMs: 2 * MINUTE_MS,
    stuckMs: 15 * MINUTE_MS,
    batchSize: 50,
    maxJobs: 500,
    newBatchId: () => `redrive-${dispatched.length + 1}`,
    batchIsAlive: workflows.isAlive,
    dispatch: async (batchId, jobIds) => {
      workflows.created(batchId);
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
    await claimBatch(new Workflows(), "batch-1", [first, second], PASS_STARTED);

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
    await claimBatch(new Workflows(), "batch-1", [first, second], PASS_STARTED);

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
   * A `sending` job the scheduler re-drives gets a second send Workflow behind it, and `runSend`
   * short-circuits only a job already `sent` — so both render and both call `send`. One person, two
   * emails. Two things stand between a live batch and that: `updatedAt`, which decides whether a row is
   * old enough to ask about, and the batch's own liveness, which decides the answer. Both are driven
   * here, separately, because either alone is a gate that cannot fail.
   */
  test("a live batch that resumes past stuckMs is not re-driven as stranded", async () => {
    const jobId = await enqueue("ada@example.com", "job-1");
    const workflows = new Workflows();
    await claimBatch(workflows, "batch-1", [jobId], PASS_STARTED);

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
    // planted journaled heartbeat before the journal was shared.
    const journal = new Map<string, unknown>();

    // The step fails and is contained, so the body completes with that job `unfinished` (#380). What
    // matters here is unchanged: the attempt wrote the row, and the batch's own liveness is what the
    // scheduler asks about. Before #380 this call rejected, which is the same fact one layer out.
    expect((await runSendBatch(deps, journalledStep(journal), [jobId])).jobs[0]?.state).toBe("unfinished");
    expect((await jobRow(jobId)).status).toBe("sending");

    // The Workflow backs off and re-executes the body twenty minutes later — past `stuckMs`.
    clock = RESUMED;
    await runSendBatch(deps, journalledStep(journal), [jobId]);
    // The pass instant did come back from the journal — so the two clocks genuinely disagree here, and
    // the assertion below is about which one `updatedAt` took.
    expect(journal.get("pass-instant")).toBe(PASS_STARTED.getTime());

    // The criterion, stated as the thing that must not happen: no second send Workflow against a job
    // this batch is still working.
    expect(await tick(new Date(RESUMED.getTime() + MINUTE_MS), workflows)).toEqual([]);
    // And the attempt just made wrote the heartbeat, which is the other half of the reason.
    expect((await jobRow(jobId)).updated_at).toBe(RESUMED.getTime());
  });

  test("and the heartbeat still carries the row on its own, with nothing vouching for the batch", async () => {
    // The same drive with the veto taken away, because a test that leaves it in place proves nothing
    // about `updatedAt`: the batch would be spared whatever the row said, and a sweep that journaled
    // the clock — the defect #327 was opened for, and reverted for — would pass it. Here the row's own
    // freshness is the only thing between the job and a second Workflow.
    const jobId = await enqueue("ada@example.com", "job-1");
    const workflows = new Workflows();
    await claimBatch(workflows, "batch-1", [jobId], PASS_STARTED);
    const { sender } = fakeSender(() => {
      throw new Error("upstream hiccup");
    });
    let clock = PASS_STARTED;
    const deps = batchDeps(sender, () => clock);
    const journal = new Map<string, unknown>();

    // Contained per job since #380, so these complete rather than rejecting. The row is what is on
    // trial here, and the attempts still write it.
    await runSendBatch(deps, journalledStep(journal), [jobId]);
    clock = RESUMED;
    await runSendBatch(deps, journalledStep(journal), [jobId]);

    // The runtime spends the last retry: the instance is gone and vouches for nothing.
    workflows.gaveUp("batch-1");
    expect(await tick(new Date(RESUMED.getTime() + MINUTE_MS), workflows)).toEqual([]);
  });

  test("and the detector still catches a batch that really did die", async () => {
    // The vacuity check on both tests above. A scheduler that never re-drives anything would satisfy
    // them trivially, and the safety net it would have removed is what recovers a dispatch that never
    // started. The same row, untouched for twenty minutes, must be claimed.
    const jobId = await enqueue("ada@example.com", "job-1");
    const workflows = new Workflows();
    await claimBatch(workflows, "batch-1", [jobId], PASS_STARTED);
    workflows.gaveUp("batch-1");

    expect(await tick(new Date(RESUMED.getTime() + MINUTE_MS), workflows)).toEqual([[jobId]]);
  });
});

/**
 * The queue behind the batch (pithy-sh/pithy#340, pithy-sh/pithy#342).
 *
 * `runScheduler` claims a whole batch up front — every id stamped with the one instant of the claim —
 * and dispatches a single Workflow for it. The batch then walks that list one job at a time, so every
 * job it has not reached carries the claim instant and nothing writes to those rows until it arrives. A
 * batch that takes longer to walk than `stuckMs` used to have its own unreached jobs re-driven out from
 * under it: two drivers, one job, both sending. It needs no crash and no resume. It needs a queue.
 *
 * #340 answered it by having each step renew the claim on the jobs behind it. Correct, quadratic, and
 * silent about the case below it — a step waiting out its retry backoff is running no body, so it renews
 * nothing while being entirely alive.
 *
 * The claim is the batch now, and the batch is a Workflow instance the scheduler can ask about. Nothing
 * is written to a job that is not being sent, and both cases are the same question.
 */
describe("runSendBatch — the queue behind the batch", () => {
  /** `count` jobs claimed as one batch, in order, all stamped with the one instant of the claim. */
  async function claimedBatch(workflows: Workflows, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) ids.push(await enqueue(`user-${i}@example.com`, `job-${i}`));
    await claimBatch(workflows, "batch-1", ids, PASS_STARTED);
    return ids;
  }

  test("a batch still working through its queue is not re-driven at the far end of it", async () => {
    const workflows = new Workflows();
    const ids = await claimedBatch(workflows, 5);
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
      if (name === `send-${last}`) dispatched.push(...(await tick(clock, workflows)));
    });

    await runSendBatch(deps, step, ids);

    // The criterion, stated as the thing that must not happen: no second send Workflow against a job
    // this batch is on its way to.
    expect(dispatched).toEqual([]);
    expect(sent).toHaveLength(5);
    // And the last job was as untouched as a dead batch's would have been. What spared it was the batch,
    // not a write — which is the whole of the fix, and what a renewal-shaped one cannot claim.
    expect((await jobRow(last)).sent_at).toBe(PASS_STARTED.getTime());
  });

  test("and a batch backing off mid-queue keeps the jobs behind the step it is retrying", async () => {
    // The case a renewal cannot cover, and the one this issue reproduced: the first send throws
    // retryably, the body unwinds, and the instance sits in backoff. Every row in the batch now carries
    // the claim instant — the one in the step included — and nothing will write to any of them until the
    // retry fires. Past `stuckMs` that is indistinguishable from a dead dispatch by timestamp alone.
    const workflows = new Workflows();
    const ids = await claimedBatch(workflows, 3);
    const { sender, sent } = fakeSender(() => {
      throw new Error("upstream hiccup");
    });
    const deps = batchDeps(sender, () => PASS_STARTED);
    const journal = new Map<string, unknown>();

    // The first send throws and its step is spent; the instance then unwinds before the second, which
    // is the runner refusing to start a step rather than a job failing — so it is not contained (#380).
    // That is the backoff this case is about: the jobs behind it are never reached.
    await expect(runSendBatch(deps, journalledStep(journal, `send-${ids[1]}`), ids)).rejects.toBeInstanceOf(
      Interrupted,
    );
    expect(sent).toHaveLength(1);
    // Every row of the batch, at the claim instant, twenty minutes stale.
    for (const id of ids) expect((await jobRow(id)).updated_at).toBe(PASS_STARTED.getTime());

    expect(await tick(new Date(PASS_STARTED.getTime() + 20 * MINUTE_MS), workflows)).toEqual([]);

    // And the retry fires and finishes the batch — the proof it was alive the whole time it was being
    // asked about, rather than a stalled instance the fake happened to leave marked `running`.
    const { sender: recovered } = fakeSender(() => ({ messageId: "msg" }));
    await runSendBatch(
      batchDeps(recovered, () => RESUMED),
      journalledStep(journal),
      ids,
    );
    for (const id of ids) expect((await jobRow(id)).status).toBe("sent");
  });

  test("and a batch that dies part-way leaves its tail recoverable", async () => {
    // The vacuity check. A veto that could not be withdrawn would satisfy both tests above and quietly
    // delete the safety net: a dispatch that dies mid-queue must still have its unreached jobs
    // re-driven, or those emails are never sent at all.
    const workflows = new Workflows();
    const ids = await claimedBatch(workflows, 5);
    const { sender } = fakeSender(() => ({ messageId: "msg" }));
    const deps = batchDeps(sender, () => PASS_STARTED);

    await expect(
      runSendBatch(deps, journalledStep(new Map<string, unknown>(), `send-${ids[2]}`), ids),
    ).rejects.toBeInstanceOf(Interrupted);
    // Nothing runs for twenty minutes and the runtime spends the last retry. The three jobs it never
    // reached are genuinely stranded.
    workflows.gaveUp("batch-1");

    expect(await tick(new Date(PASS_STARTED.getTime() + 20 * MINUTE_MS), workflows)).toEqual([ids.slice(2)]);
  });

  test("and a job the batch has finished carries the instant it was sent, not the batch's", async () => {
    // Nothing may write to a job the batch is not sending — that is what makes the cost linear — and the
    // reverse of it matters too: a row held perpetually fresh by its batch is a row the safety net can
    // never recover. Each job's stamp is its own send and nothing else.
    const workflows = new Workflows();
    const ids = await claimedBatch(workflows, 3);
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
});

/**
 * The cost of a batch (pithy-sh/pithy#342).
 *
 * #340's renewal is correct and quadratic. Each send step renews the whole remaining tail, so a batch
 * of N pays N(N-1)/2 row updates for its bookkeeping alone — 1,225 at the shipped `SCHEDULER_BATCH_SIZE`
 * of 50, and that variable has no ceiling. The comment above it argues carefully for renewing inside the
 * step rather than around it, and it is right about staleness. It did not count the writes.
 *
 * So the count is asserted here, against **D1's own report** rather than against our idea of how many
 * statements we issued. `meta.rows_written` is what the platform charges for and what a batch of a
 * hundred thousand rows would actually cost, and a fix that moved the same writes behind fewer
 * statements would not move this number at all.
 */
describe("runSendBatch — the cost of a batch", () => {
  /** Read a property off a platform object without losing its `this` — workerd's D1 objects need it. */
  function passThrough(target: object, property: PropertyKey): unknown {
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }

  /**
   * D1, wrapped so every row it reports writing is added to `tally`.
   *
   * Statements are proxied rather than counted at the call site: `bind` returns a new statement, and a
   * driver reaches `run` through it, so the wrapper has to follow the object rather than the code.
   */
  function countingD1(d1: D1Database, tally: { rows: number }): D1Database {
    const count = <T>(result: T): T => {
      const meta = (result as { meta?: { rows_written?: number } } | null)?.meta;
      if (typeof meta?.rows_written === "number") tally.rows += meta.rows_written;
      return result;
    };
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(inner, key) {
          if (key === "bind") return (...values: unknown[]) => wrapStatement(inner.bind(...values));
          if (key === "run" || key === "all") {
            return async (...args: unknown[]) =>
              count(await (passThrough(inner, key) as (...a: unknown[]) => Promise<unknown>)(...args));
          }
          return passThrough(inner, key);
        },
      });
    return new Proxy(d1, {
      get(target, property) {
        if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const result of results) count(result);
            return results;
          };
        }
        return passThrough(target, property);
      },
    });
  }

  /** Rows written to the jobs/events database while a batch of `count` claimed jobs is sent. */
  async function bookkeepingRows(count: number): Promise<number> {
    for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
      await env.DB.prepare(`delete from ${table}`).run();
    }
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) ids.push(await enqueue(`user-${i}@example.com`, `cost-job-${i}`));
    await claimBatch(new Workflows(), "cost-batch", ids, PASS_STARTED);

    const tally = { rows: 0 };
    const { sender } = fakeSender(() => ({ messageId: "msg" }));
    const deps = batchDeps(sender, () => PASS_STARTED, { db: emailDatabase(countingD1(env.DB, tally)) });
    await runSendBatch(deps, journalledStep(new Map<string, unknown>()), ids);
    return tally.rows;
  }

  test("bookkeeping grows with the batch, not with its square", { timeout: 60_000 }, async () => {
    const small = await bookkeepingRows(10);
    const large = await bookkeepingRows(50);

    // A per-job budget. The send's own work is two patches of the job row and one event insert, and
    // SQLite charges each of those for the indexes they move as well — ten rows a job, measured, with
    // two more allowed for a schema that grows an index. Nothing else may be written on a job's behalf.
    // The renewal this replaced pays 1,225 rows on top at this size, so it is not near the line: 1,725
    // against 600.
    expect(large, `a batch of 50 wrote ${large} rows`).toBeLessThanOrEqual(12 * 50);

    // And the shape, which the ceiling alone cannot state: five times the jobs, about five times the
    // cost. Quadratic bookkeeping is twenty-five times, and no ceiling chosen today would hold at the
    // batch size an operator sets tomorrow.
    expect(large, `10 jobs wrote ${small} rows, 50 wrote ${large}`).toBeLessThanOrEqual(6 * small);
  });
});

/**
 * **A job whose step is spent costs its own send, not the batch's (#380).**
 *
 * `runSendBatch`'s own docblock has promised since the file was written that *a single bad recipient
 * never blocks the rest of the batch*, and the loop did not do it: a step that exhausted its retries
 * threw, the throw came out of the loop, and every job behind it went unsent — on that attempt and on
 * every replay of the body, because a replay serves the journal and arrives at the same failing step.
 *
 * These tests exist to fail when the containment is removed. The failure is planted where a real one
 * lands: the job row is deleted out from under the batch, which is one of the terminal step failures
 * `worker.ts` names, and `runSend` throws `NotFoundError` on it.
 */
describe("runSendBatch — a job whose step will not finish", () => {
  /** Delete a job row mid-batch — a real terminal failure, not a stubbed step runner. */
  async function deleteJob(jobId: string): Promise<void> {
    await env.DB.prepare("delete from pithy_email_jobs where id = ?").bind(jobId).run();
  }

  test("every job behind the spent one still sends", async () => {
    const first = await enqueue("ada@example.com", "job-1");
    const second = await enqueue("bob@example.com", "job-2");
    const third = await enqueue("cy@example.com", "job-3");
    await deleteJob(second);
    const { sender, sent } = fakeSender(() => ({ messageId: "m" }));

    const report = await runSendBatch(
      batchDeps(sender, () => PASS_STARTED),
      journalledStep(new Map<string, unknown>()),
      [first, second, third],
    );

    expect(sent.map((message) => message.to)).toEqual(["ada@example.com", "cy@example.com"]);
    expect(report.jobs.map((job) => [job.jobId, job.state])).toEqual([
      [first, "attempted"],
      [second, "unfinished"],
      [third, "attempted"],
    ]);
  });

  test("the unfinished job carries its id and no outcome — there is no status to read as sent", async () => {
    const first = await enqueue("ada@example.com", "job-1");
    await deleteJob(first);
    const { sender } = fakeSender(() => ({ messageId: "m" }));

    const report = await runSendBatch(
      batchDeps(sender, () => PASS_STARTED),
      journalledStep(new Map<string, unknown>()),
      [first],
    );

    expect(report.jobs[0]).toEqual({ state: "unfinished", jobId: first });
    // Nothing derived from the throw travels: a send failure's own words carry an address, a provider
    // response, and sometimes the rendered link.
    expect(JSON.stringify(report)).not.toContain("not found");
  });

  test("a clean batch reports every job attempted, with its outcome behind the state", async () => {
    const first = await enqueue("ada@example.com", "job-1");
    const second = await enqueue("bob@example.com", "job-2");
    const { sender } = fakeSender(() => ({ messageId: "m" }));

    const report = await runSendBatch(
      batchDeps(sender, () => PASS_STARTED),
      journalledStep(new Map<string, unknown>()),
      [first, second],
    );

    expect(report.jobs.every((job) => job.state === "attempted")).toBe(true);
    expect(report.jobs.map((job) => job.state === "attempted" && job.outcome.status)).toEqual(["sent", "sent"]);
  });

  test("a runner that will not start a step is not contained — that is the instance dying, not a job", async () => {
    const first = await enqueue("ada@example.com", "job-1");
    const second = await enqueue("bob@example.com", "job-2");
    const { sender, sent } = fakeSender(() => ({ messageId: "m" }));

    // `interruptBefore` throws without ever calling the step body — which is the durable mechanism
    // refusing, not this job's send failing. Containing it would be a body carrying on inside an
    // instance that is being torn down.
    await expect(
      runSendBatch(
        batchDeps(sender, () => PASS_STARTED),
        journalledStep(new Map<string, unknown>(), `send-${second}`),
        [first, second],
      ),
    ).rejects.toBeInstanceOf(Interrupted);
    expect(sent.map((message) => message.to)).toEqual(["ada@example.com"]);
  });
});
