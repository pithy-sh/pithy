// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import { testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import { listSnapshots } from "../roster/read";
import { createCohort, type WriteDeps } from "../roster/write";
import { type DailyPassStep, type DurableDailyPassDeps, runDurableDailyPass } from "./pass";

/**
 * The durable pass across a resume (pithy-sh/pithy#328).
 *
 * A Workflow does not resume inside the step it died in. It re-executes this body from the top and
 * serves every completed step from the journal, so anything the body computes outside a step is computed
 * again on the newer clock. The clock here decides the **day key** every snapshot is filed under, and a
 * pass that begins at 23:58 and resumes at 00:05 filed one run's cohorts under two different days — a
 * chart with two half-days where one day belongs, and nothing later corrects it.
 *
 * These drive the real thing: run, abandon, resume against the same journal. A step runner that only
 * re-invokes one callback cannot see this defect, because the clock read is not in a callback.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });

/** Two minutes before midnight UTC. The pass begins here. */
const BEFORE_MIDNIGHT = new Date("2026-06-01T23:58:00.000Z");
/** Seven minutes later, and a day later. An ordinary Workflow backoff, not a pathological outage. */
const AFTER_MIDNIGHT = new Date("2026-06-02T00:05:00.000Z");

let sequence = 0;

function write(now: Date): WriteDeps {
  return { db: testersDatabase(env.DB), now, newId: () => `id-${++sequence}` };
}

function deps(clock: () => Date, overrides: Partial<DurableDailyPassDeps> = {}): DurableDailyPassDeps {
  return {
    db: testersDatabase(env.DB),
    d1: env.DB,
    config: CONFIG,
    clock,
    newId: () => `id-${++sequence}`,
    // No mail in these tests: what is under examination is which day a snapshot is filed under, and a
    // nudge would only add rows to a table this file never reads.
    enqueue: undefined,
    suppressionD1: undefined,
    log: noopLogger,
    optOutLinkFor: undefined,
    linkFor: undefined,
    ...overrides,
  };
}

async function makeCohort(name: string, now = BEFORE_MIDNIGHT) {
  return createCohort(write(now), {
    name,
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    targetPlatform: "android",
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
  });
}

/**
 * The Workflow journal, structurally: a completed step returns what it returned the first time, and a
 * step never reached runs.
 *
 * `abandonBefore` models an eviction rather than a step failure, and the difference matters here. The
 * pass catches a per-cohort throw on purpose — one cohort's bad day must not cost the others theirs — so
 * a runner that threw once would be *handled*, and the run would carry on and finish. A real instance
 * that is evicted simply stops, so once this runner is triggered every later step refuses too, and the
 * journal is left holding exactly the steps that genuinely completed.
 */
function journalledStep(journal: Map<string, unknown>, abandonBefore?: string, ran?: string[]): DailyPassStep {
  const runner = {
    abandoned: false,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (journal.has(name)) return journal.get(name) as T;
      if (runner.abandoned || name === abandonBefore) {
        runner.abandoned = true;
        throw new Error(`the instance was evicted before ${name}`);
      }
      ran?.push(name);
      const result = await fn();
      journal.set(name, result);
      return result;
    },
  };
  return runner;
}

/** Every day key this cohort has a snapshot under. */
async function snapshotDays(cohortId: string): Promise<string[]> {
  const snapshots = await listSnapshots(testersDatabase(env.DB), cohortId, 20);
  return snapshots.map((snapshot) => snapshot.snapshotOn).sort();
}

beforeEach(async () => {
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const table of [
    "pithy_testers_cohort_snapshots",
    "pithy_testers_events",
    "pithy_testers_members",
    "pithy_testers_cohorts",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await testers_0001_cohorts.up(untyped);
  sequence = 0;
});

describe("runDurableDailyPass — a pass that crosses midnight", () => {
  test("files every cohort under the day the pass began, not the day it came back", async () => {
    const first = await makeCohort("first");
    const second = await makeCohort("second");

    let clock = BEFORE_MIDNIGHT;
    const runDeps = deps(() => clock);
    const journal = new Map<string, unknown>();

    // The first attempt takes the first cohort and is evicted before the second.
    await runDurableDailyPass(runDeps, journalledStep(journal, `cohort-${second.id}`), {});
    expect(await snapshotDays(first.id)).toEqual(["2026-06-01"]);
    expect(await snapshotDays(second.id)).toEqual([]);

    // The body re-executes on the newer clock. That is the platform, not the test being clever.
    clock = AFTER_MIDNIGHT;
    const results = await runDurableDailyPass(runDeps, journalledStep(journal), {});

    expect(await snapshotDays(second.id)).toEqual(["2026-06-01"]);
    expect(results.map((result) => result.snapshotOn)).toEqual(["2026-06-01", "2026-06-01"]);
  });

  test("and the cohort the journal already holds is not passed a second time", async () => {
    // Without this the assertion above could pass for the wrong reason: a second run over the first
    // cohort would rewrite its row under the resumed day, and the day it is filed under would be right
    // only because the upsert happened to land on the same key.
    const first = await makeCohort("first");
    const second = await makeCohort("second");

    let clock = BEFORE_MIDNIGHT;
    const ran: string[] = [];
    const runDeps = deps(() => clock);
    const journal = new Map<string, unknown>();

    await runDurableDailyPass(runDeps, journalledStep(journal, `cohort-${second.id}`, ran), {});
    clock = AFTER_MIDNIGHT;
    await runDurableDailyPass(runDeps, journalledStep(journal, undefined, ran), {});

    expect(ran.filter((name) => name === `cohort-${first.id}`)).toHaveLength(1);
    expect(ran.filter((name) => name === `cohort-${second.id}`)).toHaveLength(1);
    // And the instant itself came back from the journal rather than being read again.
    expect(ran.filter((name) => name === "pass-instant")).toHaveLength(1);
  });

  test("a single-cohort pass is filed under its own start too", async () => {
    // `params.cohortId` is the operator's path — `pithy testers run --cohort` and the dashboard — and it
    // takes a different branch through the body, so it needs its own statement rather than an assumption
    // that the loop covered it. A gate over one branch while the defect lives on the other is the shape
    // this repository keeps producing.
    const only = await makeCohort("only");
    let clock = BEFORE_MIDNIGHT;
    const runDeps = deps(() => clock);
    const journal = new Map<string, unknown>();

    await runDurableDailyPass(runDeps, journalledStep(journal, `cohort-${only.id}`), { cohortId: only.id }).catch(
      () => undefined,
    );
    expect(await snapshotDays(only.id)).toEqual([]);

    clock = AFTER_MIDNIGHT;
    const results = await runDurableDailyPass(runDeps, journalledStep(journal), { cohortId: only.id });

    expect(results.map((result) => result.snapshotOn)).toEqual(["2026-06-01"]);
    expect(await snapshotDays(only.id)).toEqual(["2026-06-01"]);
  });
});
