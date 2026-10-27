// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { leaderboard_0001_entries } from "./0001_entries";
import { LEADERBOARD_MIGRATIONS } from "./all";

/**
 * The control-plane migration (#817): an entry's result id, the contributions a result made, and the
 * moderation history. Appended rather than folded into `0001`, because the leaderboard has shipped and
 * its first migration is somebody's database.
 */

function provider(migrations: Record<string, Migration>): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "leaderboard", order: LEADERBOARD_MIGRATION_ORDER, migrations },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_leaderboard_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_stale_windows",
    "pithy_leaderboard_moderations",
    "pithy_leaderboard_contributions",
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

describe("leaderboard_0002_control_plane", () => {
  test("is the second migration in the chain, after the shipped first", () => {
    expect(Object.keys(LEADERBOARD_MIGRATIONS)).toEqual(["0001_entries", "0002_control_plane"]);
    expect(LEADERBOARD_MIGRATIONS["0001_entries"]).toBe(leaderboard_0001_entries);
  });

  test("adds a nullable result_id to entries, and an entry written before it reads as null", async () => {
    await runMigrations(env.DB, provider({ "0001_entries": leaderboard_0001_entries }));
    await env.DB.prepare(
      "INSERT INTO pithy_leaderboard_entries (board_id, window_key, user_id, score, achieved_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("b1", "all", "u1", 10, 1, 1)
      .run();

    await runMigrations(env.DB, provider(LEADERBOARD_MIGRATIONS));

    expect(await columns("pithy_leaderboard_entries")).toContain("result_id");
    const entry = await entryStore(leaderboardDatabase(env.DB)).get("b1", "all", "u1");
    expect(entry?.resultId).toBeNull();
  });

  test("creates the contributions, moderation and stale-window tables", async () => {
    await runMigrations(env.DB, provider(LEADERBOARD_MIGRATIONS));
    expect(await tables()).toEqual([
      "pithy_leaderboard_boards",
      "pithy_leaderboard_contributions",
      "pithy_leaderboard_entries",
      "pithy_leaderboard_locks",
      "pithy_leaderboard_moderations",
      "pithy_leaderboard_stale_windows",
    ]);
    expect(await columns("pithy_leaderboard_stale_windows")).toEqual(["board_id", "window_key", "marked_at"]);
    expect(await columns("pithy_leaderboard_contributions")).toEqual([
      "id",
      "result_id",
      "board_id",
      "window_key",
      "user_id",
      "score",
      "aggregation",
      "created_at",
    ]);
    expect(await columns("pithy_leaderboard_moderations")).toEqual([
      "id",
      "idempotency_key",
      "act",
      "board_id",
      "window_key",
      "user_id",
      "lock_name",
      "reason",
      "before",
      "after",
      "changed",
      "connection_id",
      "actor_id",
      "created_at",
    ]);
  });

  test("a result contributes once per entry, an idempotency key is used once, and a window is marked once", async () => {
    await runMigrations(env.DB, provider(LEADERBOARD_MIGRATIONS));
    const contribution = env.DB.prepare(
      "INSERT INTO pithy_leaderboard_contributions (result_id, board_id, window_key, user_id, score, aggregation, created_at) VALUES ('r1', 'b1', 'all', 'u1', 3, 'sum', 1)",
    );
    await contribution.run();
    await expect(contribution.run()).rejects.toThrow(/UNIQUE/);

    const moderation = env.DB.prepare(
      "INSERT INTO pithy_leaderboard_moderations (idempotency_key, act, reason, before, changed, connection_id, actor_id, created_at) VALUES ('k1', 'hide', 'cheating', '{}', 1, 'c1', 'op', 1)",
    );
    await moderation.run();
    await expect(moderation.run()).rejects.toThrow(/UNIQUE/);

    const stale = env.DB.prepare(
      "INSERT INTO pithy_leaderboard_stale_windows (board_id, window_key, marked_at) VALUES ('b1', 'w1', 1)",
    );
    await stale.run();
    await expect(stale.run()).rejects.toThrow(/UNIQUE/);
  });

  test("down removes what up added and leaves the shipped tables standing", async () => {
    await runMigrations(env.DB, provider(LEADERBOARD_MIGRATIONS));
    const results = await rollbackMigration(env.DB, provider(LEADERBOARD_MIGRATIONS));
    expect(results.map((r) => [r.migrationName, r.direction, r.status])).toEqual([
      ["0400_leaderboard_0002_control_plane", "Down", "Success"],
    ]);
    expect(await tables()).toEqual([
      "pithy_leaderboard_boards",
      "pithy_leaderboard_entries",
      "pithy_leaderboard_locks",
    ]);
    expect(await columns("pithy_leaderboard_entries")).not.toContain("result_id");
  });
});
