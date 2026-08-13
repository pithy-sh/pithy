// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { renewClaim } from "./renewClaim";

/**
 * The claim renewal, at the function (pithy-sh/pithy#340).
 *
 * `sendBatch.workers.test.ts` drives what it is *for* — a live batch with a long tail that the scheduler
 * must not re-drive. These are the two properties of the statement itself that a batch-level test cannot
 * separate from the rest of the machinery: what it refuses to touch, and how wide it lets itself get.
 */

const CLAIMED = new Date("2026-06-18T12:00:00.000Z");
const RENEWED = new Date("2026-06-18T12:20:00.000Z");

let seq = 0;
async function insertJob(status: string): Promise<string> {
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
      status,
      "immediate",
      0,
      CLAIMED.getTime(),
      0,
      0,
      CLAIMED.getTime(),
      CLAIMED.getTime(),
    )
    .run();
  return id;
}

/** Insert `count` claimed jobs in one D1 batch — a per-row round trip is too slow at these sizes. */
async function insertJobs(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => `job-${++seq}`);
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        "insert into pithy_email_jobs (id, to_address, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        "u@example.com",
        "noreply@pithy.sh",
        "Acme",
        "S",
        "welcome",
        "transactional",
        "{}",
        "sending",
        "immediate",
        0,
        CLAIMED.getTime(),
        0,
        0,
        CLAIMED.getTime(),
        CLAIMED.getTime(),
      ),
    ),
  );
  return ids;
}

async function updatedAt(id: string): Promise<number> {
  const row = await env.DB.prepare("select updated_at from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ updated_at: number }>();
  if (!row) throw new Error(`no job ${id}`);
  return row.updated_at;
}

beforeEach(async () => {
  seq = 0;
  await env.DB.prepare("drop table if exists pithy_email_jobs").run();
  await env.DB.prepare("drop table if exists pithy_email_events").run();
  await email_0001_init.up(emailDatabase(env.DB));
});

describe("renewClaim", () => {
  test("renews a job the batch still holds", async () => {
    const held = await insertJob("sending");

    await renewClaim(emailDatabase(env.DB), [held], RENEWED);

    expect(await updatedAt(held)).toBe(RENEWED.getTime());
  });

  test("leaves a job that is no longer held alone", async () => {
    // It renews a claim; it does not resurrect one. A job that left `sending` while the batch still
    // listed it — cancelled, sent, failed — is not this batch's to keep alive, and a row held
    // perpetually fresh is a row the scheduler's safety net can never recover.
    const gone = ["cancelled", "sent", "failed", "suppressed", "pending"];
    const ids = await Promise.all(gone.map((status) => insertJob(status)));

    await renewClaim(emailDatabase(env.DB), ids, RENEWED);

    for (const [index, id] of ids.entries()) {
      expect(await updatedAt(id), `a ${gone[index]} job was renewed`).toBe(CLAIMED.getTime());
    }
  });

  test("stays under D1's bound-parameter cap however long the tail is", { timeout: 30_000 }, async () => {
    // `SCHEDULER_BATCH_SIZE` has no ceiling, so neither does the tail. One `in (…)` over all of it is
    // the statement that failed every cron tick in #250, and nothing at the default of 50 reaches it.
    const ids = await insertJobs(250);

    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      await renewClaim(emailDatabase(d1), ids, RENEWED);
    });

    if (error) throw error;
    const worst = Math.max(...counts, 0);
    expect(worst).toBeGreaterThan(0);
    expect(
      worst,
      `one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
    ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    // And chunking must not drop one: every job is renewed, not just the first chunk's worth.
    const renewed = await env.DB.prepare("select count(*) as n from pithy_email_jobs where updated_at = ?")
      .bind(RENEWED.getTime())
      .first<{ n: number }>();
    expect(renewed?.n).toBe(250);
  });

  test("does nothing at all for an empty tail", async () => {
    const held = await insertJob("sending");

    await renewClaim(emailDatabase(env.DB), [], RENEWED);

    // The last job of a batch has no tail, and so does every single-job batch the immediate send path
    // dispatches. Neither pays a statement for it.
    expect(await updatedAt(held)).toBe(CLAIMED.getTime());
  });
});
