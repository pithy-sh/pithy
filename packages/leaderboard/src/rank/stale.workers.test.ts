// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { type CompiledQuery, type Expression, type SqlBool, sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { leaderboardDatabase } from "../data/tables";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { clearStale, markStale, staleWindows } from "./stale";

/** The stale-window marks (#817): what marks one, what reads them, and what a pass may clear. */

const T0 = new Date(1_700_000_000_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: LEADERBOARD_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => leaderboardDatabase(env.DB);
const prepared = (d1: D1Database, compiled: CompiledQuery): D1PreparedStatement =>
  d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
const mark = (windowKey: string, when: Date, guard?: Expression<SqlBool>) =>
  prepared(env.DB, markStale(db(), "b1", windowKey, when, guard)).run();

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
  await runMigrations(env.DB, provider());
});

describe("markStale", () => {
  test("marks a window once, and a second mark moves it forward", async () => {
    await mark("w1", at(0));
    await mark("w1", at(5));
    expect(await staleWindows(db(), "b1")).toEqual([{ windowKey: "w1", markedAt: at(5).getTime() }]);
  });

  test("marks nothing when its guard is false", async () => {
    await mark("w1", at(0), sql<SqlBool>`0`);
    expect(await staleWindows(db(), "b1")).toEqual([]);
  });

  test("reads one board's marks, oldest window first", async () => {
    await mark("w2", at(0));
    await mark("w1", at(0));
    await prepared(env.DB, markStale(db(), "b2", "w9", at(0))).run();
    expect((await staleWindows(db(), "b1")).map((w) => w.windowKey)).toEqual(["w1", "w2"]);
  });
});

describe("clearStale", () => {
  test("clears the mark the pass read", async () => {
    await mark("w1", at(0));
    const [read] = await staleWindows(db(), "b1");
    if (!read) throw new Error("expected a mark");
    await clearStale(db(), "b1", read);
    expect(await staleWindows(db(), "b1")).toEqual([]);
  });

  test("keeps a mark made after the pass read it, so the next pass renumbers that change too", async () => {
    await mark("w1", at(0));
    const [read] = await staleWindows(db(), "b1");
    if (!read) throw new Error("expected a mark");
    await mark("w1", at(5));
    await clearStale(db(), "b1", read);
    expect(await staleWindows(db(), "b1")).toEqual([{ windowKey: "w1", markedAt: at(5).getTime() }]);
  });
});
