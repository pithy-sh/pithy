// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeAll, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { submitQuery } from "../entry/store";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { rankCountQuery } from "./query";

/**
 * The issue's acceptance criterion is "verify the query plan uses the index" — not "assume it does".
 * These tests compile the real ranking queries and read D1's own `EXPLAIN QUERY PLAN` for them.
 *
 * The thing being guarded against is subtle and silent: `pithy_leaderboard_entries_rank_idx` is
 * `(board_id, window_key, score, achieved_at)` and SQLite uses a multi-column index only on a
 * left-prefix subset. A score-first index would be ignored behind `board_id = ? AND window_key = ?`
 * and the board would fall back to a full table scan — which still returns the *right answer*, just at
 * O(whole table) billed rows. D1 bills rows scanned, so that regression costs money rather than
 * failing a test. Hence a test that reads the plan.
 */

const T0 = new Date(1_700_000_000_000);
const board: LeaderboardBoard = { key: "b1", direction: "desc", aggregation: "best", retain: 12 } as LeaderboardBoard;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: { "0001_entries": leaderboard_0001_entries },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function planFor(sql: string, parameters: readonly unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...parameters)
    .all<{ detail: string }>();
  return results.map((row) => row.detail).join(" | ");
}

beforeAll(async () => {
  for (const t of [
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  // Enough rows, spread across boards and windows, that a full scan is measurably the wrong plan and
  // SQLite has a reason to reach for the index.
  //
  // **Batched, and that is the fix for #361, not a tidy-up.** This hook used to `await store.submit(...)`
  // twice per iteration for two hundred iterations — **four hundred sequential D1 round trips** before a
  // single assertion — and it answers to vitest's default `hookTimeout` of **10,000ms**, which no
  // per-test budget governs. Measured: `bun run test --force` on this box under a real parallel load
  // (load average 66) failed this file with `Hook timed out in 10000ms`, while the package's slowest
  // *case* is 2,441ms, so nothing about a test body was ever near a limit. Four hundred round trips at a
  // few milliseconds each sit just under 10s on a quiet machine and over it on a busy one; that is
  // arithmetic, not flake.
  //
  // The same rows, written in batches, cost four round trips instead of four hundred. Measured on this
  // box at the same load average, one statement per round trip against `PER_BATCH` of them:
  // **3,070 / 3,060 / 3,690 ms** versus **269 / 275 / 273 ms** — an 11x cut, and the hook goes from a
  // 3.1x margin under its 10s budget to a 36x one. `submitQuery` is already exported for compiling
  // (`writeAmplification.workers.test.ts` reads `meta.rows_written` from it), so this is the real
  // statement, not an approximation of it. Every `u${i}` is distinct, so no submission in a batch
  // conflicts with another and the upsert resolution is identical either way.
  const db = leaderboardDatabase(env.DB);
  const statements = [];
  for (let i = 0; i < 200; i++) {
    for (const on of [board, { ...board, key: "b2" }]) {
      const { sql, parameters } = submitQuery(db, on, "all", `u${i}`, i, new Date(T0.getTime() + i), true).compile();
      statements.push(env.DB.prepare(sql).bind(...parameters));
    }
  }
  /** Statements per `batch`. Four round trips for the four hundred rows, rather than four hundred. */
  const PER_BATCH = 100;
  for (let i = 0; i < statements.length; i += PER_BATCH) await env.DB.batch(statements.slice(i, i + PER_BATCH));
  await env.DB.exec("ANALYZE");
});

describe("live rank count", () => {
  test("uses the ranking index and never scans the table", async () => {
    const compiled = rankCountQuery(leaderboardDatabase(env.DB), board, "all", {
      score: 100,
      achievedAt: T0,
      userId: "u100",
    }).compile();
    const plan = await planFor(compiled.sql, compiled.parameters);
    expect(plan).toContain("pithy_leaderboard_entries_rank_idx");
    expect(plan).not.toMatch(/SCAN pithy_leaderboard_entries(?! USING)/);
  });
});

describe("top-N page", () => {
  test("uses the ranking index for the ordering rather than sorting the whole board", async () => {
    const compiled = leaderboardDatabase(env.DB)
      .selectFrom("pithyLeaderboardEntries")
      .selectAll()
      .where("boardId", "=", "b1")
      .where("windowKey", "=", "all")
      .where("visible", "=", 1)
      .where("hidden", "=", 0)
      .orderBy("score", "desc")
      .orderBy("achievedAt", "asc")
      .orderBy("userId", "asc")
      .limit(10)
      .compile();
    const plan = await planFor(compiled.sql, compiled.parameters);
    expect(plan).toContain("pithy_leaderboard_entries_rank_idx");
  });
});

describe("my-entry point read", () => {
  test("uses the unique player index", async () => {
    const compiled = leaderboardDatabase(env.DB)
      .selectFrom("pithyLeaderboardEntries")
      .selectAll()
      .where("boardId", "=", "b1")
      .where("windowKey", "=", "all")
      .where("userId", "=", "u100")
      .compile();
    const plan = await planFor(compiled.sql, compiled.parameters);
    expect(plan).toContain("pithy_leaderboard_entries_player_idx");
  });
});
