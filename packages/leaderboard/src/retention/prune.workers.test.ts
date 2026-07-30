// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
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
      migrations: { "0001_entries": leaderboard_0001_entries },
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

beforeEach(async () => {
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
});

describe("pruneBoard", () => {
  test("keeps the open window plus `retain` closed ones, and deletes the rest", async () => {
    const b = board({ window: DAILY, retain: 2 });
    const keys = await seedDays(6, b);
    const deleted = await pruneBoard(db(), b, NOW);
    // 6 windows seeded, 1 open + 2 retained kept.
    expect(deleted).toBe(3);
    const store = entryStore(db());
    for (const key of keys.slice(0, 3)) expect(await store.get("b1", key, "u1")).toBeDefined();
    for (const key of keys.slice(3)) expect(await store.get("b1", key, "u1")).toBeUndefined();
  });

  test("keeps only the open window when retain is zero", async () => {
    const b = board({ window: DAILY, retain: 0 });
    const keys = await seedDays(3, b);
    expect(await pruneBoard(db(), b, NOW)).toBe(2);
    expect(await entryStore(db()).get("b1", keys[0] as string, "u1")).toBeDefined();
  });

  test("deletes nothing when the board has fewer windows than it retains", async () => {
    const b = board({ window: DAILY, retain: 12 });
    await seedDays(3, b);
    expect(await pruneBoard(db(), b, NOW)).toBe(0);
  });

  test("never prunes an all-time board, which has no closed window to expire", async () => {
    const b = board();
    await entryStore(db()).submit(b, "all", "u1", 10, NOW, true);
    expect(await pruneBoard(db(), b, NOW)).toBe(0);
    expect(await entryStore(db()).get("b1", "all", "u1")).toBeDefined();
  });

  test("never touches another board's history", async () => {
    const b = board({ window: DAILY, retain: 0 });
    const other = board({ key: "b2", window: DAILY, retain: 0 });
    const keys = await seedDays(3, other);
    await seedDays(3, b);
    await pruneBoard(db(), b, NOW);
    for (const key of keys) expect(await entryStore(db()).get("b2", key, "u1")).toBeDefined();
  });

  test("keeps everything by default — a windowed board with no limit set deletes nothing", async () => {
    // The default is keep-all: storage is not the cost driver, so nothing goes unless the adopter asks.
    const b = board({ window: DAILY });
    const keys = await seedDays(30, b);
    expect(await pruneBoard(db(), b, NOW)).toBe(0);
    for (const key of keys) expect(await entryStore(db()).get("b1", key, "u1")).toBeDefined();
  });

  test("handles a retain past D1's 100-bound-parameter cap", async () => {
    // retain 100 would need a 101-key keep-list — over D1's 100-bound-parameter cap under a NOT IN.
    // The cutoff-delete implementation uses two bound params regardless, so this just works. (A daily
    // board keeping a year, retain 365, is the real-world case; 100 proves the fix at less seed cost.)
    const b = board({ window: DAILY, retain: 100 });
    const keys = await seedDays(110, b);
    const deleted = await pruneBoard(db(), b, NOW);
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
    const deleted = await pruneBoard(db(), b, NOW);
    // The window open 7 days ago and everything newer is kept: 8 windows (today .. 7 days ago).
    const store = entryStore(db());
    for (const key of keys.slice(0, 8)) expect(await store.get("b1", key, "u1")).toBeDefined();
    for (const key of keys.slice(8)) expect(await store.get("b1", key, "u1")).toBeUndefined();
    expect(deleted).toBe(keys.length - 8);
  });

  test("keeps everything when all windows are within the age horizon", async () => {
    const b = board({ window: DAILY, retainDays: 90 });
    await seedDays(10, b);
    expect(await pruneBoard(db(), b, NOW)).toBe(0);
  });

  test("never prunes an all-time board even with retainDays — it has no window age", async () => {
    // Config forbids retainDays on an all-time board, but pruneBoard must also be safe if handed one.
    const b = board({ retainDays: 1 });
    await entryStore(db()).submit(b, "all", "u1", 10, new Date(NOW.getTime() - 100 * 86_400_000), true);
    expect(await pruneBoard(db(), b, NOW)).toBe(0);
    expect(await entryStore(db()).get("b1", "all", "u1")).toBeDefined();
  });

  test("never touches another board's history", async () => {
    const b = board({ window: DAILY, retainDays: 3 });
    const other = board({ key: "b2", window: DAILY, retainDays: 3 });
    const keys = await seedDays(20, other);
    await seedDays(20, b);
    await pruneBoard(db(), b, NOW);
    for (const key of keys) expect(await entryStore(db()).get("b2", key, "u1")).toBeDefined();
  });
});

describe("pruneBoards", () => {
  test("prunes every windowed board and totals the rows deleted", async () => {
    const b1 = board({ window: DAILY, retain: 0 });
    const b2 = board({ key: "b2", window: DAILY, retain: 0 });
    await seedDays(3, b1);
    await seedDays(3, b2);
    expect(await pruneBoards(db(), [b1, b2], NOW)).toBe(4);
  });
});
