// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import emailHost, { type EmailWorkerEnv } from "./worker";

/**
 * The cron entry (pithy-sh/pithy#538).
 *
 * `scheduled()` used to create a scheduler Workflow every minute and let the instance discover there
 * was nothing to do. At `* * * * *` that is 1,440 instance creations and 1,440 billed steps a day per
 * environment, against a Workers Free allowance of 3,000 steps a day for the whole account — so a
 * default project's staging and prod spent 96% of it sending no mail.
 *
 * The question moved out in front of the instance: the cron probes for a due row and creates nothing
 * when there is none. What is asserted here is that gate — that an idle minute leaves no instance, and
 * that every kind of due row still gets one.
 */

const NOW_MS = Date.now();
const MINUTE = 60_000;

/** The scheduler Workflow binding, recording what the cron asked it to start. */
function fakeScheduler() {
  const started: unknown[] = [];
  return { started, create: async (options?: unknown) => void started.push(options ?? null) };
}

let seq = 0;
async function insertJob(opts: { status: string; sendAt: number; createdAt?: number; updatedAt?: number }) {
  const id = `job-${++seq}`;
  await env.DB.prepare(
    "insert into pithy_email_jobs (id, to_address, recipient_key, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
      opts.sendAt,
      0,
      0,
      opts.createdAt ?? opts.sendAt,
      opts.updatedAt ?? opts.sendAt,
    )
    .run();
  return id;
}

/** The host's env as the runtime hands it over: the real D1 bindings, stand-ins for the rest. */
function workerEnv(overrides: Partial<EmailWorkerEnv> = {}): EmailWorkerEnv {
  return {
    DB: env.DB,
    EMAIL_SUPPRESSIONS: env.EMAIL_SUPPRESSIONS,
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: env.SECRETS_ENCRYPTION_KEYS,
    EMAIL: { send: async () => {} },
    EMAIL_SENDER: { create: async () => ({}), get: async () => ({ status: async () => ({ status: "running" }) }) },
    EMAIL_SCHEDULER: fakeScheduler(),
    BASE_URL: "https://app.example.com",
    ENVIRONMENT: "staging",
    ...overrides,
  } as unknown as EmailWorkerEnv;
}

beforeEach(async () => {
  seq = 0;
  for (const table of ["pithy_email_jobs", "pithy_email_events", "pithy_email_suppressions"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await email_0001_init.up(emailDatabase(env.DB));
});

describe("the every-minute cron", () => {
  test("creates nothing when nothing is due", async () => {
    const scheduler = fakeScheduler();

    await emailHost.scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler }));

    expect(scheduler.started).toEqual([]);
  });

  test("creates nothing for rows that are not due yet", async () => {
    await insertJob({ status: "scheduled", sendAt: NOW_MS + 10 * MINUTE });
    await insertJob({ status: "pending", sendAt: NOW_MS, createdAt: NOW_MS });
    await insertJob({ status: "sent", sendAt: NOW_MS - 30 * MINUTE, updatedAt: NOW_MS - 30 * MINUTE });
    const scheduler = fakeScheduler();

    await emailHost.scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler }));

    expect(scheduler.started).toEqual([]);
  });

  test.each([
    ["a scheduled job whose sendAt has arrived", { status: "scheduled", sendAt: NOW_MS - MINUTE }],
    [
      "a pending immediate job past its grace",
      { status: "pending", sendAt: NOW_MS - 5 * MINUTE, createdAt: NOW_MS - 5 * MINUTE },
    ],
    [
      "an undispatched job past its grace",
      { status: "undispatched", sendAt: NOW_MS - 5 * MINUTE, createdAt: NOW_MS - 5 * MINUTE },
    ],
    [
      "a sending job past stuckMs",
      { status: "sending", sendAt: NOW_MS - 30 * MINUTE, updatedAt: NOW_MS - 30 * MINUTE },
    ],
  ])("starts the scheduler for %s", async (_label, row) => {
    await insertJob(row);
    const scheduler = fakeScheduler();

    await emailHost.scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler }));

    expect(scheduler.started).toHaveLength(1);
  });

  test("starts one instance however many rows are due — the tick does the fan-out", async () => {
    for (let i = 0; i < 5; i += 1) await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const scheduler = fakeScheduler();

    await emailHost.scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler }));

    expect(scheduler.started).toHaveLength(1);
  });

  test("the maintenance switch still wins, and costs not even the probe", async () => {
    await insertJob({ status: "scheduled", sendAt: NOW_MS - MINUTE });
    const scheduler = fakeScheduler();
    let read = false;
    // Flagged on the call, not on the lookup: the env schema itself checks that `prepare` is a
    // function, so a proxy that flags on `get` would report a read that never happened.
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            read = true;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await emailHost.scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler, DB: db, SCHEDULER_ENABLED: "false" }));

    expect(scheduler.started).toEqual([]);
    expect(read).toBe(false);
  });

  test("an env the host cannot work on is refused, not quietly skipped", async () => {
    const scheduler = fakeScheduler();

    // A missing BASE_URL is a magic link to `undefined/…` (pithy-sh/pithy#410). The probe must not
    // become a way for such a host to look idle and healthy: the env is validated first, as before.
    const failure = await emailHost
      .scheduled(undefined, workerEnv({ EMAIL_SCHEDULER: scheduler, BASE_URL: undefined as unknown as string }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeDefined();
    expect(scheduler.started).toEqual([]);
  });
});
