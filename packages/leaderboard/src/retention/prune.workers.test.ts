// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { clearLock, moderateEntry } from "../admin/moderate";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import {
  LEADERBOARD_CONTRIBUTIONS_TABLE,
  LEADERBOARD_MODERATIONS_TABLE,
  LEADERBOARD_STALE_WINDOWS_TABLE,
  leaderboardDatabase,
} from "../data/tables";
import { submitResult } from "../entry/result";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { windowKeyAt } from "../window/schedule";
import { pruneBoard, pruneBoards } from "./prune";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const DAILY = "0 0 * * *";

// No `retain`/`retainDays` by default — keep-all is the real default. Tests opt into a limit explicitly.
const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({ key: "b1", direction: "desc", aggregation: "best", ...overrides }) as LeaderboardBoard;

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

/** Seed one entry per day for `days` consecutive days, ending with the window `NOW` falls in. */
async function seedDays(days: number, b: LeaderboardBoard): Promise<string[]> {
  const store = entryStore(db());
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(NOW.getTime() - i * 24 * 60 * 60 * 1000);
    const key = windowKeyAt(DAILY, day);
    keys.push(key);
    await store.submit(b, key, "u1", 10, day, true);
  }
  return keys;
}

/**
 * A D1 that refuses every statement bound to one board's key, and answers everything else for real. The
 * same wrapper the rank-pass suite uses, and for the same reason: the sibling boards must run against a
 * real database or the gate proves nothing about the loop.
 */
function d1RefusingBoard(base: D1Database, boardKey: string): D1Database {
  const wrap = <T extends object>(target: T, key: string, replacement: (...args: never[]) => unknown): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        if (property === key) return replacement;
        const value = Reflect.get(object, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  return wrap(base, "prepare", (sql: never) => {
    const statement = base.prepare(sql);
    return wrap(statement, "bind", (...values: never[]) => {
      if (values.includes(boardKey as never)) throw new Error(`D1_ERROR: no such table: retained_${boardKey}`);
      return statement.bind(...values);
    });
  });
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
  await runMigrations(env.DB, provider());
});

describe("pruneBoard", () => {
  test("keeps the open window plus `retain` closed ones, and deletes the rest", async () => {
    const b = board({ window: DAILY, retain: 2 });
    const keys = await seedDays(6, b);
    const deleted = await pruneBoard(env.DB, b, NOW);
    // 6 windows seeded, 1 open + 2 retained kept.
    expect(deleted).toBe(3);
    const store = entryStore(db());
    for (const key of keys.slice(0, 3)) expect(await store.get("b1", key, "u1")).toBeDefined();
    for (const key of keys.slice(3)) expect(await store.get("b1", key, "u1")).toBeUndefined();
  });

  test("keeps only the open window when retain is zero", async () => {
    const b = board({ window: DAILY, retain: 0 });
    const keys = await seedDays(3, b);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(2);
    expect(await entryStore(db()).get("b1", keys[0] as string, "u1")).toBeDefined();
  });

  test("deletes nothing when the board has fewer windows than it retains", async () => {
    const b = board({ window: DAILY, retain: 12 });
    await seedDays(3, b);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(0);
  });

  test("never prunes an all-time board, which has no closed window to expire", async () => {
    const b = board();
    await entryStore(db()).submit(b, "all", "u1", 10, NOW, true);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(0);
    expect(await entryStore(db()).get("b1", "all", "u1")).toBeDefined();
  });

  test("never touches another board's history", async () => {
    const b = board({ window: DAILY, retain: 0 });
    const other = board({ key: "b2", window: DAILY, retain: 0 });
    const keys = await seedDays(3, other);
    await seedDays(3, b);
    await pruneBoard(env.DB, b, NOW);
    for (const key of keys) expect(await entryStore(db()).get("b2", key, "u1")).toBeDefined();
  });

  test("keeps everything by default — a windowed board with no limit set deletes nothing", async () => {
    // The default is keep-all: storage is not the cost driver, so nothing goes unless the adopter asks.
    const b = board({ window: DAILY });
    const keys = await seedDays(30, b);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(0);
    for (const key of keys) expect(await entryStore(db()).get("b1", key, "u1")).toBeDefined();
  });

  test("handles a retain past D1's 100-bound-parameter cap", async () => {
    // retain 100 would need a 101-key keep-list — over D1's 100-bound-parameter cap under a NOT IN.
    // The cutoff-delete implementation uses two bound params regardless, so this just works. (A daily
    // board keeping a year, retain 365, is the real-world case; 100 proves the fix at less seed cost.)
    const b = board({ window: DAILY, retain: 100 });
    const keys = await seedDays(110, b);
    const deleted = await pruneBoard(env.DB, b, NOW);
    // 110 windows seeded, 1 open + 100 closed kept → 9 deleted.
    expect(deleted).toBe(110 - 101);
    const store = entryStore(db());
    expect(await store.get("b1", keys[0] as string, "u1")).toBeDefined(); // today, kept
    expect(await store.get("b1", keys[100] as string, "u1")).toBeDefined(); // 100 days ago, kept
    expect(await store.get("b1", keys[101] as string, "u1")).toBeUndefined(); // 101 days ago, pruned
  });
});

describe("pruneBoard — retainDays (age-based)", () => {
  test("deletes windows whose data is older than retainDays, keeps the rest", async () => {
    const b = board({ window: DAILY, retainDays: 7 });
    const keys = await seedDays(20, b); // keys[0] = today, keys[i] = i days ago
    const deleted = await pruneBoard(env.DB, b, NOW);
    // The window open 7 days ago and everything newer is kept: 8 windows (today .. 7 days ago).
    const store = entryStore(db());
    for (const key of keys.slice(0, 8)) expect(await store.get("b1", key, "u1")).toBeDefined();
    for (const key of keys.slice(8)) expect(await store.get("b1", key, "u1")).toBeUndefined();
    expect(deleted).toBe(keys.length - 8);
  });

  test("takes every player's data in a pruned window with it — contributions, moderation history and stale marks too", async () => {
    // `retainDays` is a compliance limit. A result's contribution row and a moderation's before/after both
    // hold a player's id and score, so a window that is gone from the board must be gone from them as well.
    const b = board({ window: DAILY, retainDays: 7 });
    const keys = await seedDays(10, b);
    const kept = keys[0] as string;
    const expired = keys[9] as string;
    for (const windowKey of [kept, expired]) {
      await submitResult(env.DB, {
        board: b,
        windowKey,
        userId: "u2",
        score: 5,
        at: NOW,
        visibleByDefault: true,
        resultId: `s-${windowKey}`,
      });
      await moderateEntry(env.DB, {
        act: "hide",
        board: b,
        windowKey,
        userId: "u1",
        idempotencyKey: `k-${windowKey}`,
        reason: "Impossible run.",
        actor: { connectionId: "c1", actorId: "a1" },
        materialized: true,
        now: NOW,
      });
    }

    await pruneBoard(env.DB, b, NOW);

    const contributions = await db().selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE).select("windowKey").execute();
    expect(contributions.map((row) => row.windowKey)).toEqual([kept]);
    const moderations = await db().selectFrom(LEADERBOARD_MODERATIONS_TABLE).select("windowKey").execute();
    expect(moderations.map((row) => row.windowKey)).toEqual([kept]);
    const stale = await db().selectFrom(LEADERBOARD_STALE_WINDOWS_TABLE).select("windowKey").execute();
    expect(stale.map((row) => row.windowKey)).toEqual([kept]);
  });

  test("leaves a cleared lock's history, which belongs to no window", async () => {
    const b = board({ window: DAILY, retainDays: 7 });
    await seedDays(10, b);
    await env.DB.prepare(
      "INSERT INTO pithy_leaderboard_locks (name, holder, acquired_at) VALUES ('refresh', 'h1', 0)",
    ).run();
    await clearLock(env.DB, {
      name: "refresh",
      holder: "h1",
      idempotencyKey: "k-lock",
      reason: "Dead instance.",
      actor: { connectionId: "c1", actorId: "a1" },
      now: NOW,
    });

    await pruneBoard(env.DB, b, NOW);

    const moderations = await db().selectFrom(LEADERBOARD_MODERATIONS_TABLE).select("act").execute();
    expect(moderations).toEqual([{ act: "clear_lock" }]);
  });

  test("keeps everything when all windows are within the age horizon", async () => {
    const b = board({ window: DAILY, retainDays: 90 });
    await seedDays(10, b);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(0);
  });

  test("never prunes an all-time board even with retainDays — it has no window age", async () => {
    // Config forbids retainDays on an all-time board, but pruneBoard must also be safe if handed one.
    const b = board({ retainDays: 1 });
    await entryStore(db()).submit(b, "all", "u1", 10, new Date(NOW.getTime() - 100 * 86_400_000), true);
    expect(await pruneBoard(env.DB, b, NOW)).toBe(0);
    expect(await entryStore(db()).get("b1", "all", "u1")).toBeDefined();
  });

  test("never touches another board's history", async () => {
    const b = board({ window: DAILY, retainDays: 3 });
    const other = board({ key: "b2", window: DAILY, retainDays: 3 });
    const keys = await seedDays(20, other);
    await seedDays(20, b);
    await pruneBoard(env.DB, b, NOW);
    for (const key of keys) expect(await entryStore(db()).get("b2", key, "u1")).toBeDefined();
  });
});

describe("pruneBoards", () => {
  test("prunes every windowed board and totals the rows deleted", async () => {
    const b1 = board({ window: DAILY, retain: 0 });
    const b2 = board({ key: "b2", window: DAILY, retain: 0 });
    await seedDays(3, b1);
    await seedDays(3, b2);
    expect(await pruneBoards(env.DB, [b1, b2], NOW)).toEqual({ state: "pruned", deleted: 4 });
  });

  /**
   * The #371 gate on the sweep. One board's prune throws; the deletions the sweep already made survive,
   * and the sweep says which board it did not reach.
   */
  test("a board whose prune throws costs its own entry, never its siblings", async () => {
    const b1 = board({ window: DAILY, retain: 0 });
    const b2 = board({ key: "b2", window: DAILY, retain: 0 });
    await seedDays(3, b1);
    await seedDays(3, b2);

    const outcome = await pruneBoards(d1RefusingBoard(env.DB, "b2"), [b1, b2], NOW);

    expect(outcome).toEqual({ state: "partial", counted: { deleted: 2 }, unpruned: ["b2"] });
    // Not a clean sweep of two rows. `partial` and `pruned` share no field, so a caller reaches the
    // total only after being told it is short.
    expect("deleted" in outcome).toBe(false);
    // And nothing the D1 failure said travels — only the board key, which is the adopter's own config.
    expect(JSON.stringify(outcome)).not.toMatch(/retained_|D1_ERROR/);
  });
});
