// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { auth_0001_init } from "@pithy-sh/auth/src/migrations/0001_init";
import { authPeer } from "@pithy-sh/auth/src/peer";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { TestersConfig } from "../config/config";
import type { TestersCohort } from "../data/cohort";
import { testersDatabase } from "../data/tables";
import { testers_0001_cohorts } from "../migrations/0001_cohorts";
import { readCohort } from "../roster/read";
import { confirmOptIn, createCohort, inviteMember, recordAccepted } from "../roster/write";
import { type DailyPassDeps, runCohortPass } from "./daily";

/**
 * **A reader that forgets auth fails typecheck, and one that passes it sees who came** (#645 review).
 *
 * `pithy testers list`, `status`, `roster` and `run` built their calls without auth: `readCohort` took it as an
 * optional seventh argument and the pass's deps as an optional key, so leaving it out typechecked. A project that
 * composes auth then read every tester `unobservable`, and `run` wrote `{ observed_count: 0, active_count: 0 }`
 * for the day — a snapshot that is history, and wrong. Both are now required, with `undefined` said out loud by a
 * project that has no auth. The `@ts-expect-error` lines below fail typecheck the day either becomes optional.
 */

const CONFIG = TestersConfig.parse({ baseUrl: "https://api.example.test" });
const NOW = new Date("2026-06-03T05:00:00.000Z");
let sequence = 0;
const write = () => ({ db: testersDatabase(env.DB), now: NOW, newId: () => `id-${++sequence}` });

/** The pass's deps, as the CLI's `run` builds them, with `auth` as the one thing a case chooses. */
function deps(auth: DailyPassDeps["auth"]): DailyPassDeps {
  return {
    db: testersDatabase(env.DB),
    d1: env.DB,
    config: CONFIG,
    now: NOW,
    newId: () => `id-${++sequence}`,
    log: noopLogger,
    enqueue: undefined,
    suppressionD1: undefined,
    optOutLinkFor: () => "https://api.example.test/out",
    linkFor: undefined,
    auth,
  };
}

let cohort: TestersCohort;

beforeEach(async () => {
  for (const table of [
    "pithy_testers_cohort_snapshots",
    "pithy_testers_events",
    "pithy_testers_members",
    "pithy_testers_cohorts",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const untyped = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await testers_0001_cohorts.up(untyped);
  // Every auth table `0001_init` creates, children first, so it applies from nothing on every case.
  for (const table of [
    "pithy_auth_rotated_tokens",
    "pithy_auth_devices",
    "pithy_auth_rate_limit",
    "pithy_auth_jwks",
    "pithy_auth_verifications",
    "pithy_auth_accounts",
    "pithy_auth_sessions",
    "pithy_auth_users",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await auth_0001_init.up(untyped);
  cohort = await createCohort(write(), {
    name: "closed-test",
    targetSize: 2,
    windowDays: 14,
    maxRosterSize: 10,
    targetPlatform: "android",
    storeOptInUrl: "https://play.google.com/apps/testing/com.example.app",
    resetPolicy: "reset",
  });
  const { member } = await inviteMember(write(), { cohortId: cohort.id, email: "ada@example.com", maxRosterSize: 10 });
  await recordAccepted(write(), member.id);
  await confirmOptIn(write(), member.id);
  const at = NOW.toISOString();
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, created_at, updated_at) values ('u1', 'Ada', 'ada@example.com', 1, ?, ?)",
  )
    .bind(at, at)
    .run();
  await env.DB.prepare(
    "insert into pithy_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) values ('s1', ?, 't1', ?, ?, 'u1')",
  )
    .bind(at, at, at)
    .run();
});

describe("auth is a required argument of every activity read", () => {
  test("readCohort handed the composed auth observes the tester who signed in today", async () => {
    const reading = await readCohort(testersDatabase(env.DB), env.DB, cohort, CONFIG, NOW, noopLogger, authPeer);
    expect(reading.readings[0]?.activity.observability).toBe("observed");
  });

  test("readCohort without auth is a type error, not a quiet `unobservable`", () => {
    // @ts-expect-error — the six-argument shape `pithy testers list|status|roster` shipped with.
    const forgot = () => readCohort(testersDatabase(env.DB), env.DB, cohort, CONFIG, NOW, noopLogger);
    expect(typeof forgot).toBe("function");
  });

  test("a pass handed the composed auth writes a snapshot that counts who was observed", async () => {
    await runCohortPass(deps(authPeer), cohort.id);
    const snapshot = await env.DB.prepare(
      "select observed_count, active_count from pithy_testers_cohort_snapshots",
    ).first();
    expect(snapshot).toMatchObject({ observed_count: 1, active_count: 1 });
  });

  test("a pass's deps without auth is a type error, not a day of nobody observed", () => {
    const { auth: _auth, ...forgot } = deps(authPeer);
    // @ts-expect-error — the deps `pithy testers run` shipped with: no `auth` key at all.
    const shipped: DailyPassDeps = forgot;
    expect(shipped).not.toHaveProperty("auth");
  });
});
