// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { emailDatabase } from "@pithy-sh/email/src/data/tables";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { runScheduler } from "@pithy-sh/email/src/workflows/scheduler";
import { beforeEach, describe, expect, test } from "vitest";
import { buildNudgeEnqueue, type NudgeEnqueueEnv } from "./enqueueSeam";

/**
 * The liveness half of pithy-sh/pithy#328, stated against the thing that would actually go wrong.
 *
 * The pass journals one clock so its day key survives a resume. This seam must **not** read that clock.
 * `enqueueEmail` writes the instant it is given as the job's `createdAt`, and the email scheduler
 * re-drives any `pending` job whose `createdAt` is older than `graceMs`, on the assumption its dispatch
 * died. A nudge stamped with an instant the pass read an hour ago is therefore born already past that
 * cutoff: the next scheduler tick claims it and starts a second send Workflow against the one
 * `enqueueEmail` just dispatched. `runSend` short-circuits only a job already `sent`, so both attempts
 * render and both send. That is a double-send, and it is why this is asserted against a real scheduler
 * tick rather than against a timestamp.
 *
 * A sweep journalled exactly this clock once and was reverted for it. The second test below is the
 * hazard itself, driven — so nobody has to take the first one's word for why it matters.
 */

/** Two minutes, the scheduler's default `graceMs`. */
const GRACE_MS = 2 * 60_000;
/** Fifteen minutes, the scheduler's default `stuckMs`. */
const STUCK_MS = 15 * 60_000;

const NOW = new Date("2026-06-18T12:00:00.000Z");
/** The instant a pass that began an hour ago journalled. Well past the grace cutoff by the time it enqueues. */
const AN_HOUR_AGO = new Date(NOW.getTime() - 60 * 60_000);

function seamEnv(): NudgeEnqueueEnv {
  return {
    DB: env.DB,
    EMAIL_FROM_ADDRESS: "noreply@example.test",
    EMAIL_FROM_NAME: "Acme",
    // No send binding: this asserts what the scheduler does with the row, and a dispatch here would only
    // add a Workflow neither test has a way to observe.
    EMAIL_SENDER: undefined,
  };
}

const nudge = {
  to: "ada@example.com",
  template: "testerNudge",
  payload: { subject: "Still testing?", heading: "Still testing?", paragraphs: ["Two more days."] },
};

/** One scheduler tick at `NOW`, with the defaults the email worker ships. Returns what it claimed. */
async function tick(): Promise<number> {
  const result = await runScheduler({
    db: emailDatabase(env.DB),
    now: NOW,
    graceMs: GRACE_MS,
    stuckMs: STUCK_MS,
    batchSize: 50,
    maxJobs: 500,
    // Both cases below hold `undispatched` rows, which carry no batch and so are never asked about
    // (pithy-sh/pithy#342, pithy-sh/pithy#410 for the status). `false` is therefore the answer that reproduces the behavior this seam was
    // written against: a liveness answer may only veto a re-drive, never cause one.
    newBatchId: () => "batch-nudge",
    batchIsAlive: async () => false,
    dispatch: async () => {},
  });
  return result.due;
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_email_events");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_email_jobs");
  await email_0001_init.up(emailDatabase(env.DB));
});

describe("buildNudgeEnqueue", () => {
  test("stamps a nudge with the clock of the moment, so the scheduler leaves it alone", async () => {
    // A moving clock, read through the seam. A build-time read answers with the pass's stale instant; a
    // per-nudge read answers with now. Only one of them survives the tick below.
    let clock = AN_HOUR_AGO;
    const enqueue = await buildNudgeEnqueue(seamEnv(), () => clock);
    if (!enqueue) throw new Error("the seam refused to build");

    clock = NOW;
    await enqueue(nudge);

    const row = await env.DB.prepare("select created_at, status from pithy_email_jobs").first<{
      created_at: number;
      status: string;
    }>();
    expect(row?.created_at).toBe(NOW.getTime());
    // `undispatched` rather than `pending`, and that is this deployment's own shape rather than a
    // detail of the fixture (pithy-sh/pithy#410). Nothing in testers' host binds a send Workflow —
    // `EMAIL_SENDER` is absent from its `wrangler.jsonc`, its resolver and its worker — so every nudge
    // it enqueues has always been left for the email scheduler to claim. The row now says so instead
    // of claiming a dispatch is on its way. What it does not change is what happens next: the
    // scheduler claims `undispatched` beside `pending` under the same grace window, which is what the
    // tick below and the one in the next test measure between them.
    expect(row?.status).toBe("undispatched");
    // Nothing due: the job was born inside the grace window, which is what tells the scheduler its
    // dispatch is still in flight.
    expect(await tick()).toBe(0);
  });

  test("and a nudge stamped with the pass's journalled instant is claimed by the very next tick", async () => {
    // The hazard, driven rather than described. This is what journalling this clock produces, and the
    // claim below is a second send Workflow against a job the enqueue has already dispatched.
    let clock = AN_HOUR_AGO;
    const enqueue = await buildNudgeEnqueue(seamEnv(), () => clock);
    if (!enqueue) throw new Error("the seam refused to build");

    // Never advanced: the seam is handed a frozen clock, exactly as a journalled pass instant would be.
    clock = AN_HOUR_AGO;
    await enqueue(nudge);

    expect(await tick()).toBe(1);
  });

  test("no sending identity means no seam, rather than mail from a domain the adopter's DKIM does not cover", async () => {
    expect(await buildNudgeEnqueue({ DB: env.DB })).toBeUndefined();
    expect(await buildNudgeEnqueue({ DB: env.DB, EMAIL_FROM_ADDRESS: "noreply@example.test" })).toBeUndefined();
  });
});
