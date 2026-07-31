// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { testers_0001_cohorts } from "./0001_cohorts";

/**
 * The migration against a real Miniflare D1 — never a mock. Every `UNIQUE` and `CHECK` in this file is a
 * constraint SQLite enforces or does not; asserting them against a fake would prove only that the test
 * agrees with itself.
 */

/** `createDatabase(env.DB, {})` — the empty map is the idiom for handing a migration an untyped Kysely. */
const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

/** Every testers object SQLite knows about. Proves the `pithy_testers_` prefix rather than trusting it. */
async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_testers_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

const TABLES = [
  "pithy_testers_cohort_snapshots",
  "pithy_testers_events",
  "pithy_testers_members",
  "pithy_testers_cohorts",
];

/** A cohort row, as SQLite stores it. */
const COHORT = {
  id: "cohort-1",
  name: "closed-test",
  target_platform: "android",
  target_size: 12,
  window_days: 14,
  max_roster_size: 100,
  reset_policy: "reset",
  closed_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

async function insertCohort(overrides: Record<string, unknown> = {}): Promise<unknown> {
  const row = { ...COHORT, ...overrides };
  return env.DB.prepare(
    `insert into pithy_testers_cohorts
     (id, name, target_platform, target_size, window_days, max_roster_size, reset_policy, closed_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.name,
      row.target_platform,
      row.target_size,
      row.window_days,
      row.max_roster_size,
      row.reset_policy,
      row.closed_at,
      row.created_at,
      row.updated_at,
    )
    .run();
}

async function insertMember(overrides: Record<string, unknown> = {}): Promise<unknown> {
  const row = {
    id: "member-1",
    cohort_id: "cohort-1",
    email: "ada@example.com",
    name: null,
    opt_in_token: "token-member-1",
    state: "invited",
    invited_at: 1_700_000_000_000,
    accepted_at: null,
    opted_in_at: null,
    lapsed_at: null,
    last_invited_at: 1_700_000_000_000,
    last_nudged_at: null,
    nudge_count: 0,
    unreachable: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
  return env.DB.prepare(
    `insert into pithy_testers_members
     (id, cohort_id, email, name, opt_in_token, state, invited_at, accepted_at, opted_in_at, lapsed_at,
      last_invited_at, last_nudged_at, nudge_count, unreachable, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.cohort_id,
      row.email,
      row.name,
      row.opt_in_token,
      row.state,
      row.invited_at,
      row.accepted_at,
      row.opted_in_at,
      row.lapsed_at,
      row.last_invited_at,
      row.last_nudged_at,
      row.nudge_count,
      row.unreachable,
      row.created_at,
      row.updated_at,
    )
    .run();
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await testers_0001_cohorts.up(db());
});

describe("testers_0001_cohorts", () => {
  test("creates every table and explicit index, each prefixed pithy_testers_", async () => {
    // The three UNIQUE constraints are deliberately absent from this list. SQLite backs a table-level
    // UNIQUE with an implicit index it names `sqlite_autoindex_<table>_<n>` rather than the name given
    // in the DDL, so they do not match a `pithy_testers_%` scan — they are proven by the constraint
    // tests below instead, which is the stronger check anyway: that the index exists matters less than
    // that the duplicate is actually refused.
    expect(await catalog()).toEqual([
      "pithy_testers_cohort_snapshots",
      "pithy_testers_cohorts",
      "pithy_testers_events",
      "pithy_testers_events_cohort_time_idx",
      "pithy_testers_events_member_time_idx",
      "pithy_testers_members",
      "pithy_testers_members_cohort_state_idx",
      "pithy_testers_members_email_idx",
      "pithy_testers_snapshots_cohort_recent_idx",
    ]);
  });

  test("refuses a second member with the same address on one cohort", async () => {
    // The constraint that makes an invitation idempotent at the storage layer rather than only in the
    // handler. Two concurrent invites of one person would otherwise split their history across two
    // rows, double-counting them toward the target.
    await insertCohort();
    await insertMember();
    await expect(insertMember({ id: "member-2", opt_in_token: "token-member-2" })).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test("refuses two members sharing a confirmation token, across every cohort", async () => {
    // The token is the whole credential, so a collision would let one tester's link confirm another's
    // opt-in. Uniqueness is global rather than per cohort for exactly that reason.
    await insertCohort();
    await insertCohort({ id: "cohort-2", name: "second-test" });
    await insertMember();
    await expect(insertMember({ id: "member-2", cohort_id: "cohort-2", email: "grace@example.com" })).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test("allows the same address on a different cohort", async () => {
    // Someone can legitimately test two apps. The uniqueness is per cohort, not global.
    await insertCohort();
    await insertCohort({ id: "cohort-2", name: "second-test" });
    await insertMember();
    await expect(
      insertMember({ id: "member-2", cohort_id: "cohort-2", opt_in_token: "token-member-2" }),
    ).resolves.toBeDefined();
  });

  test("refuses two cohorts with the same name", async () => {
    await insertCohort();
    await expect(insertCohort({ id: "cohort-2" })).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("refuses two snapshots for one cohort on one day", async () => {
    // The constraint that makes the daily pass idempotent: a retried Workflow step, a manual backfill,
    // and two crons firing a second apart all rewrite the day rather than appending a second version.
    const insertSnapshot = () =>
      env.DB.prepare(
        `insert into pithy_testers_cohort_snapshots
         (cohort_id, snapshot_on, day_index, computed_at, backfilled, model_version, roster_size,
          invited_count, accepted_count, estimated_opted_in_count, lapsed_count, unreachable_count,
          target_size, window_days, meets_target, headroom, estimated_held_days, estimated_window_start_on,
          estimated_days_remaining, reset_count, reset_today, observed_count, never_linked_count,
          observed_coverage, active_count, dark_three_to_seven_count, dark_eight_to_thirteen_count,
          dark_fourteen_plus_count, sessions_in_window, target_platform_device_count, healthy_count,
          watch_count, at_risk_count, critical_count, unknown_health_count, median_health, min_health,
          expected_survivors, probability_reach_target, probability_hold_window, success_probability,
          success_probability_low, success_probability_high, confidence, basis, projected_target_met_on,
          projected_complete_on, invites_needed, recommended_roster_size, opted_in_delta1d, opted_in_delta7d,
          active_delta7d, success_probability_delta1d, success_probability_delta7d, trend_direction,
          fragile, trend_reason, nudges_sent, bounced_count)
         values ('cohort-1','2026-06-10',9,1,0,'1',12,0,0,12,0,0,12,14,1,0,9,'2026-06-02',5,0,0,9,3,0.75,7,1,1,0,41,9,7,1,1,0,3,90,55,11.3,1,0.71,0.71,0.55,0.84,'moderate','estimated','2026-06-10','2026-06-15',0,18,0,-1,-2,-0.02,-0.14,'declining',1,'x','{}',0)`,
      ).run();
    await insertSnapshot();
    await expect(insertSnapshot()).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  test("allows a null forecast, because 'we do not know' has to be storable", async () => {
    await expect(
      env.DB.prepare(
        `insert into pithy_testers_cohort_snapshots
         (cohort_id, snapshot_on, day_index, computed_at, backfilled, model_version, roster_size,
          invited_count, accepted_count, estimated_opted_in_count, lapsed_count, unreachable_count,
          target_size, window_days, meets_target, headroom, estimated_held_days, estimated_window_start_on,
          estimated_days_remaining, reset_count, reset_today, observed_count, never_linked_count,
          observed_coverage, active_count, dark_three_to_seven_count, dark_eight_to_thirteen_count,
          dark_fourteen_plus_count, sessions_in_window, target_platform_device_count, healthy_count,
          watch_count, at_risk_count, critical_count, unknown_health_count, median_health, min_health,
          expected_survivors, probability_reach_target, probability_hold_window, success_probability,
          success_probability_low, success_probability_high, confidence, basis, projected_target_met_on,
          projected_complete_on, invites_needed, recommended_roster_size, opted_in_delta1d, opted_in_delta7d,
          active_delta7d, success_probability_delta1d, success_probability_delta7d, trend_direction,
          fragile, trend_reason, nudges_sent, bounced_count)
         values ('cohort-1','2026-06-12',9,1,0,'1',12,0,0,12,0,0,12,14,1,0,9,NULL,5,0,0,0,12,0,0,0,0,0,0,0,0,0,0,0,12,NULL,NULL,11.3,1,NULL,NULL,NULL,NULL,NULL,'no_observable_signal',NULL,NULL,0,18,NULL,NULL,NULL,NULL,NULL,'unknown',0,'Not enough history yet.','{}',0)`,
      ).run(),
    ).resolves.toBeDefined();
  });

  test("value and shape rules are the schemas' job, and are covered where they live", () => {
    // Every `CHECK` this file used to assert has moved into the Zod objects — enum members, numeric
    // bounds, 0/1 booleans, and the one cross-field rule (`maxRosterSize >= targetSize`). One schema
    // per table is the whole table definition, so restating them in SQL was a second source of truth
    // that could drift from the first, and it failed as a raw `CHECK constraint failed` out of Kysely
    // rather than as a `PithyError` with an action line. They are tested in `data/tables.test.ts`.
    //
    // What this file still proves is what SQLite alone can enforce: the UNIQUE constraints above, which
    // are facts about the table rather than about a row and which no schema can express.
    expect(true).toBe(true);
  });

  test("down is the exact inverse, and up is re-runnable after it", async () => {
    await testers_0001_cohorts.down?.(db());
    expect(await catalog()).toEqual([]);
    await testers_0001_cohorts.up(db());
    expect(await catalog()).toHaveLength(9);
  });
});
