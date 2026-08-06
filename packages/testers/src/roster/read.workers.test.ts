// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import { TestersCohort } from "../data/cohort";
import { TESTERS_COHORTS_TABLE, testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import { readCohort } from "./read";
import { inviteMember, type WriteDeps } from "./write";

/**
 * `readCohort` as the seam that carries a caller's logger to the activity read.
 *
 * This is the only path both a request and the daily Workflow take to `resolveActivity`, so it is the
 * only place the correlation can be lost. Losing it is silent by construction: the roster still reads,
 * every member simply comes back "never signed in", and the one line explaining why is emitted into a
 * no-op. That is the same shape as a cohort which really has gone dark — the failure the log exists to
 * tell apart. So the threading needs a test that fails when the argument is dropped, not a reviewer who
 * remembers it is there.
 */

const COHORT_ID = "cohort-1";
const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });

let sequence = 0;
const write = (): WriteDeps => ({ db: testersDatabase(env.DB), now: NOW, newId: () => `id-${++sequence}` });

/** Capture what a caller's logger receives, with the correlation a request logger would already carry. */
function capturing(records: LogRecord[]) {
  return createLogger({
    level: "debug",
    name: "app",
    fields: { request: "req_1" },
    sink: (record) => records.push(record),
  });
}

async function cohort(): Promise<TestersCohort> {
  const row = TestersCohort.encode({
    id: COHORT_ID,
    name: "closed-test",
    targetPlatform: "android",
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 3,
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await testersDatabase(env.DB)
    .insertInto(TESTERS_COHORTS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side.
    .values(row as any)
    .execute();
  return TestersCohort.parse(row);
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
  // No auth tables at all — the shape of a project that never composed auth, and the shape of a D1
  // failure. Either way `resolveActivity` throws inside, catches, and has only its logger to say so.
  await env.DB.exec("DROP TABLE IF EXISTS pithy_auth_users");
});

describe("an activity read that cannot be made", () => {
  test("reaches the caller's logger, correlation and all", async () => {
    const target = await cohort();
    await inviteMember(write(), { cohortId: COHORT_ID, email: "ada@example.test", maxRosterSize: 3 });
    const records: LogRecord[] = [];

    const reading = await readCohort(testersDatabase(env.DB), env.DB, target, CONFIG, NOW, capturing(records));

    // The roster still reads. That is exactly why the log line is the only evidence.
    expect(reading.readings).toHaveLength(1);
    expect(reading.readings[0]?.activity.observability).toBe("unobservable");

    const warned = records.filter((record) => record.level === "warn");
    expect(warned).toHaveLength(1);
    // `name` and `request` are the caller's, not this module's: proof the logger travelled rather than
    // one being built inside `resolveActivity`.
    expect(warned[0]?.name).toBe("app");
    expect(warned[0]?.fields).toMatchObject({ request: "req_1", addresses: 1 });
    expect(String(warned[0]?.fields?.reason)).toContain("pithy_auth_users");
  });

  test("counts every address it tried, so a coverage cliff has a size", async () => {
    const target = await cohort();
    await inviteMember(write(), { cohortId: COHORT_ID, email: "ada@example.test", maxRosterSize: 3 });
    await inviteMember(write(), { cohortId: COHORT_ID, email: "grace@example.test", maxRosterSize: 3 });
    const records: LogRecord[] = [];

    await readCohort(testersDatabase(env.DB), env.DB, target, CONFIG, NOW, capturing(records));

    expect(records.filter((record) => record.level === "warn")[0]?.fields).toMatchObject({ addresses: 2 });
  });

  test("with no logger passed still reads the roster rather than throwing", async () => {
    const target = await cohort();
    await inviteMember(write(), { cohortId: COHORT_ID, email: "ada@example.test", maxRosterSize: 3 });

    const reading = await readCohort(testersDatabase(env.DB), env.DB, target, CONFIG, NOW);

    expect(reading.readings).toHaveLength(1);
  });
});
