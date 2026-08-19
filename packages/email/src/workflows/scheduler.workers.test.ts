// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { runScheduler, type SchedulerDeps } from "./scheduler";

const NOW = new Date("2026-06-18T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const MINUTE = 60_000;

let seq = 0;
async function insertJob(opts: {
  status: string;
  sendAt: number;
  createdAt?: number;
  updatedAt?: number;
  batchId?: string;
}): Promise<string> {
  const id = `job-${++seq}`;
  await env.DB.prepare(
    "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, batch_id, send_at, open_tracking, click_tracking, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      "u@example.com",
      "u@example.com",
      "noreply@pithy.sh",
      "Acme",
      "S",
      "welcome",
      "transactional",
      "{}",
      opts.status,
      "immediate",
      0,
      opts.batchId ?? null,
      opts.sendAt,
      0,
      0,
      opts.createdAt ?? opts.sendAt,
      opts.updatedAt ?? opts.sendAt,
    )
    .run();
  return id;
}

/** Batch ids the tick mints, in order — so a test can name the one a claim wrote. */
let minted: string[] = [];

function deps(
  dispatch: (batchId: string, ids: string[]) => Promise<void>,
  overrides: Partial<SchedulerDeps> = {},
): SchedulerDeps {
  return {
    db: emailDatabase(env.DB),
    now: NOW,
    graceMs: 2 * MINUTE,
    stuckMs: 15 * MINUTE,
    batchSize: 2,
    maxJobs: 100,
    newBatchId: () => {
      const id = `batch-${minted.length + 1}`;
      minted.push(id);
      return id;
    },
    // No batch is alive unless a test says one is. The default answers the case the safety net exists
    // for — a dispatch that is not there any more — so every pre-existing expectation still means what
    // it did, and a test asserting a *held* job has to introduce the live batch itself.
    batchIsAlive: async () => false,
    dispatch,
    ...overrides,
  };
}

/** Insert `count` due jobs in one D1 batch — a per-row round trip is too slow at these sizes. */
async function insertJobs(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => `job-${++seq}`);
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        "u@example.com",
        "u@example.com",
        "noreply@pithy.sh",
        "Acme",
        "S",
        "welcome",
        "transactional",
        "{}",
        "scheduled",
        "immediate",
        0,
        NOW_MS - MINUTE,
        0,
        0,
        NOW_MS - MINUTE,
        NOW_MS - MINUTE,
      ),
    ),
  );
  return ids;
}

/** How many jobs sit in each status — one query instead of one point read per job. */
async function statusCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("select status, count(*) as n from pithy_email_jobs group by status").all<{
    status: string;
    n: number;
  }>();
  return Object.fromEntries(results.map((row) => [row.status, row.n]));
}

async function batchIdOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("select batch_id from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ batch_id: string | null }>();
  if (!row) throw new Error(`no job ${id}`);
  return row.batch_id;
}

async function updatedAtOf(id: string): Promise<number> {
  const row = await env.DB.prepare("select updated_at from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  if (!row) throw new Error(`no job ${id}`);
  return row.updated_at;
}

async function statusOf(id: string): Promise<string> {
  const row = await env.DB.prepare("select status from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? "missing";
}

beforeEach(async () => {
  seq = 0;
  minted = [];
  for (const table of ["pithy_email_jobs", "pithy_email_events", "pithy_email_suppressions"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await email_0001_init.up(emailDatabase(env.DB));
});

describe("runScheduler", () => {
  test("claims and dispatches due scheduled jobs but leaves future ones", async () => {
    const due = await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const future = await insertJob({ status: "scheduled", sendAt: NOW_MS + MINUTE });
    const dispatched: string[][] = [];

    const result = await runScheduler(deps(async (_batchId, ids) => void dispatched.push(ids)));

    expect(result.due).toBe(1);
    expect(dispatched).toEqual([[due]]);
    expect(await statusOf(due)).toBe("sending");
    expect(await statusOf(future)).toBe("scheduled");
  });

  test("re-drives a stale pending immediate job but not a fresh one", async () => {
    const stale = await insertJob({ status: "pending", sendAt: NOW_MS - 5 * MINUTE, createdAt: NOW_MS - 5 * MINUTE });
    const fresh = await insertJob({ status: "pending", sendAt: NOW_MS, createdAt: NOW_MS });
    const dispatched: string[][] = [];

    await runScheduler(deps(async (_batchId, ids) => void dispatched.push(ids)));

    expect(dispatched.flat()).toEqual([stale]);
    expect(await statusOf(fresh)).toBe("pending");
  });

  /**
   * `undispatched` is what an immediate job is born as when the composition binds no send Workflow
   * (pithy-sh/pithy#410) — a configuration fact, and the honest thing to tell the caller. It must not
   * also be a dead end: the day the host is provisioned, its first tick is what drains the backlog of
   * magic links that were enqueued before it existed. Nothing else can — `retryJob` takes `failed`
   * rows, and no operator command moves this one.
   */
  test("claims an undispatched job once a host exists, so the backlog is not lost", async () => {
    const stranded = await insertJob({
      status: "undispatched",
      sendAt: NOW_MS - 5 * MINUTE,
      createdAt: NOW_MS - 5 * MINUTE,
    });
    const fresh = await insertJob({ status: "undispatched", sendAt: NOW_MS, createdAt: NOW_MS });
    const dispatched: string[][] = [];

    await runScheduler(deps(async (_batchId, ids) => void dispatched.push(ids)));

    expect(dispatched.flat()).toEqual([stranded]);
    // The same grace window a `pending` row gets, for the same reason: a row this tick is racing.
    expect(await statusOf(fresh)).toBe("undispatched");
  });

  test("re-drives a stranded sending job past stuckMs but not a fresh send-in-flight", async () => {
    const stranded = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
    });
    const inflight = await insertJob({ status: "sending", sendAt: NOW_MS - MINUTE, updatedAt: NOW_MS - MINUTE });
    const dispatched: string[][] = [];

    await runScheduler(deps(async (_batchId, ids) => void dispatched.push(ids)));

    expect(dispatched.flat()).toEqual([stranded]);
    expect(await statusOf(inflight)).toBe("sending");
  });

  test("fans out into more batches as volume grows", async () => {
    for (let i = 0; i < 5; i += 1) await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const dispatched: string[][] = [];

    const result = await runScheduler(deps(async (_batchId, ids) => void dispatched.push(ids)));

    expect(result.due).toBe(5);
    expect(result.batches).toBe(3); // batchSize 2 → [2,2,1]
    expect(dispatched.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  test("does nothing when no jobs are due", async () => {
    await insertJob({ status: "scheduled", sendAt: NOW_MS + 10 * MINUTE });
    let called = false;

    const result = await runScheduler(
      deps(async () => {
        called = true;
      }),
    );

    expect(result).toEqual({ due: 0, batches: 0, held: 0 });
    expect(called).toBe(false);
  });
});

/**
 * The claim is the batch (pithy-sh/pithy#342).
 *
 * A row's timestamp cannot say whether the driver holding it is alive. Two live batches look exactly
 * like a dead one from here — a batch waiting out a step's retry backoff writes nothing, and a batch
 * three quarters down a long queue has written nothing to the quarter it has not reached — so the tick
 * asks the Workflow runtime about the batch instead of reading the row's age as a verdict.
 *
 * These are the policy, in isolation. The batches they describe are driven for real in
 * `sendBatch.workers.test.ts`, which is where the states come from something other than a stub.
 */
describe("runScheduler and the batch behind a stale row", () => {
  test("a stale sending job is left where it is while its batch is alive", async () => {
    const held = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
      batchId: "live-batch",
    });
    const dispatched: string[][] = [];

    const result = await runScheduler(
      deps(async (_batchId, ids) => void dispatched.push(ids), { batchIsAlive: async () => true }),
    );

    expect(dispatched).toEqual([]);
    expect(result).toEqual({ due: 0, batches: 0, held: 1 });
    // Untouched, not merely undispatched: a claim that re-stamped the row would hide the next tick's
    // evidence and leave the job unrecoverable if the batch does die.
    expect(await batchIdOf(held)).toBe("live-batch");
    expect(await updatedAtOf(held)).toBe(NOW_MS - 30 * MINUTE);
  });

  test("and re-driven the moment its batch is not", async () => {
    // The vacuity check on the test above, one dependency apart from it. A veto that could not be
    // withdrawn would be a scheduler that never recovers anything, which is the failure this whole
    // safety net exists to prevent — the emails simply never go out.
    const dead = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
      batchId: "dead-batch",
    });
    const dispatched: string[][] = [];

    const result = await runScheduler(
      deps(async (_batchId, ids) => void dispatched.push(ids), { batchIsAlive: async () => false }),
    );

    expect(dispatched).toEqual([[dead]]);
    expect(result).toEqual({ due: 1, batches: 1, held: 0 });
    expect(await batchIdOf(dead)).toBe("batch-1");
  });

  test("a job no batch ever claimed is re-driven without a question being asked", async () => {
    // The signal is the batch, so a row that names none is stranded by definition — nothing claimed it,
    // or whatever did died before it could say so. Asking about a batch that does not exist would be the
    // start of inventing an answer for it.
    const orphan = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
    });
    const asked: string[] = [];
    const dispatched: string[][] = [];

    await runScheduler(
      deps(async (_batchId, ids) => void dispatched.push(ids), {
        batchIsAlive: async (batchId) => {
          asked.push(batchId);
          return true;
        },
      }),
    );

    expect(asked).toEqual([]);
    expect(dispatched).toEqual([[orphan]]);
  });

  test("one question per batch, however many of its rows look stale", async () => {
    // Fifty stale rows of one stalled batch are one question about one Workflow. Asking per row would
    // put the tick's cost back on the batch size, which is the shape this issue is about.
    for (let i = 0; i < 20; i += 1) {
      await insertJob({
        status: "sending",
        sendAt: NOW_MS - 30 * MINUTE,
        updatedAt: NOW_MS - 30 * MINUTE,
        batchId: i < 12 ? "batch-a" : "batch-b",
      });
    }
    const asked: string[] = [];

    await runScheduler(
      deps(async () => {}, {
        batchIsAlive: async (batchId) => {
          asked.push(batchId);
          return true;
        },
      }),
    );

    expect(asked).toEqual(["batch-a", "batch-b"]);
  });

  test("a batch the runtime cannot be asked about is still recovered", async () => {
    // The answer may only ever veto a re-drive, so an unavailable one declines to save an email rather
    // than deciding to send a second. A tick that gave up here would strand the batch for good.
    const stale = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
      batchId: "unreachable",
    });
    const dispatched: string[][] = [];

    await runScheduler(
      deps(async (_batchId, ids) => void dispatched.push(ids), {
        // What `worker.ts` turns a rejected `EMAIL_SENDER.get` into: not alive.
        batchIsAlive: async () => false,
      }),
    );

    expect(dispatched).toEqual([[stale]]);
  });

  test("each dispatched batch is claimed under the id its Workflow is created with", async () => {
    // The two have to be the same string or the next tick asks about an instance nobody started. This is
    // the only place they are both visible.
    for (let i = 0; i < 3; i += 1) await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const dispatched: { batchId: string; ids: string[] }[] = [];

    await runScheduler(deps(async (batchId, ids) => void dispatched.push({ batchId, ids })));

    expect(dispatched.map((d) => d.batchId)).toEqual(["batch-1", "batch-2"]); // batchSize 2 → [2,1]
    for (const { batchId, ids } of dispatched) {
      for (const id of ids) expect(await batchIdOf(id)).toBe(batchId);
    }
  });
});

/**
 * The claim statement, at the batch size an operator can actually set.
 *
 * `SCHEDULER_BATCH_SIZE` is a deployment variable with no ceiling. The default of 50 binds 52 and is
 * safe; 100 binds 102, and **every cron tick fails** — silently, for as long as it takes somebody to
 * read a Workflow's logs. Nothing that runs at the default can reach it, which is why a green suite
 * never mentioned it (#250).
 */
describe("runScheduler and D1's bound-parameter ceiling", () => {
  test("a batch size of 100 claims and dispatches its jobs", async () => {
    const ids = await insertJobs(100);
    const dispatched: string[][] = [];

    const result = await runScheduler(deps(async (_batchId, batch) => void dispatched.push(batch), { batchSize: 100 }));

    expect(result).toEqual({ due: 100, batches: 1, held: 0 });
    expect(dispatched.flat().sort()).toEqual([...ids].sort());
    expect(await statusCounts()).toEqual({ sending: 100 });
  });

  test("no statement binds more than D1 accepts, at any batch size", { timeout: 30_000 }, async () => {
    const ids = await insertJobs(250);

    // Sizes spanning the budget the claim's two fixed parameters leave: under it, on it, past it.
    for (const batchSize of [1, 50, 98, 99, 250]) {
      await env.DB.prepare("update pithy_email_jobs set status = 'scheduled'").run();
      const dispatched: string[][] = [];
      const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
        await runScheduler(
          deps(async (_batchId, batch) => void dispatched.push(batch), {
            batchSize,
            db: emailDatabase(d1),
            maxJobs: 500,
          }),
        );
      });

      const worst = Math.max(...counts, 0);
      expect(worst, `batchSize ${batchSize}: nothing was bound`).toBeGreaterThan(0);
      expect(
        worst,
        `batchSize ${batchSize}: one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
      if (error) throw error;

      // Chunking the claim must not lose a job, and must not change the fan-out the operator asked for.
      expect(dispatched.flat().sort()).toEqual([...ids].sort());
      expect(dispatched.every((batch) => batch.length <= batchSize)).toBe(true);
      expect(await statusCounts()).toEqual({ sending: 250 });
    }
  });

  test("a batch size that is not a positive whole number is refused, naming the variable", async () => {
    // No job inserted: a misconfigured worker should complain on an idle tick too.
    for (const batchSize of [Number.NaN, 0, -1, 2.5]) {
      const failure = await runScheduler(deps(async () => {}, { batchSize })).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `batchSize ${batchSize} was accepted`).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.detail).toContain("SCHEDULER_BATCH_SIZE");
    }
  });
});
