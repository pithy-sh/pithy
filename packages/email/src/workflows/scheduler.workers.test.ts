// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
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
}): Promise<string> {
  const id = `job-${++seq}`;
  await env.DB.prepare(
    "insert into pithy_email_jobs (id, to_address, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
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
      opts.sendAt,
      0,
      0,
      opts.createdAt ?? opts.sendAt,
      opts.updatedAt ?? opts.sendAt,
    )
    .run();
  return id;
}

function deps(dispatch: (ids: string[]) => Promise<void>, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    db: emailDatabase(env.DB),
    now: NOW,
    graceMs: 2 * MINUTE,
    stuckMs: 15 * MINUTE,
    batchSize: 2,
    maxJobs: 100,
    dispatch,
    ...overrides,
  };
}

async function statusOf(id: string): Promise<string> {
  const row = await env.DB.prepare("select status from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? "missing";
}

beforeEach(async () => {
  seq = 0;
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

    const result = await runScheduler(deps(async (ids) => void dispatched.push(ids)));

    expect(result.due).toBe(1);
    expect(dispatched).toEqual([[due]]);
    expect(await statusOf(due)).toBe("sending");
    expect(await statusOf(future)).toBe("scheduled");
  });

  test("re-drives a stale pending immediate job but not a fresh one", async () => {
    const stale = await insertJob({ status: "pending", sendAt: NOW_MS - 5 * MINUTE, createdAt: NOW_MS - 5 * MINUTE });
    const fresh = await insertJob({ status: "pending", sendAt: NOW_MS, createdAt: NOW_MS });
    const dispatched: string[][] = [];

    await runScheduler(deps(async (ids) => void dispatched.push(ids)));

    expect(dispatched.flat()).toEqual([stale]);
    expect(await statusOf(fresh)).toBe("pending");
  });

  test("re-drives a stranded sending job past stuckMs but not a fresh send-in-flight", async () => {
    const stranded = await insertJob({
      status: "sending",
      sendAt: NOW_MS - 30 * MINUTE,
      updatedAt: NOW_MS - 30 * MINUTE,
    });
    const inflight = await insertJob({ status: "sending", sendAt: NOW_MS - MINUTE, updatedAt: NOW_MS - MINUTE });
    const dispatched: string[][] = [];

    await runScheduler(deps(async (ids) => void dispatched.push(ids)));

    expect(dispatched.flat()).toEqual([stranded]);
    expect(await statusOf(inflight)).toBe("sending");
  });

  test("fans out into more batches as volume grows", async () => {
    for (let i = 0; i < 5; i += 1) await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const dispatched: string[][] = [];

    const result = await runScheduler(deps(async (ids) => void dispatched.push(ids)));

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

    expect(result).toEqual({ due: 0, batches: 0 });
    expect(called).toBe(false);
  });
});
