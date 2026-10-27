// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { type AdminEntry, type EntriesQuery, listEntries } from "./read";

/**
 * The management listing (#817), against D1: keyset pages in the board's own total order — score in the
 * board's direction, then earliest `achievedAt`, then `userId` — with hidden and unconsented entries in place
 * and unranked, and every ranked row numbered on from a live count.
 *
 * The cases that matter are the boundaries a page can fall on. Two entries on one score are where a wrong
 * tiebreak skips or repeats a row, so most of the rows below share a score, and the board is walked one row
 * at a time so every pair of neighbors is a page boundary.
 */

const WINDOW = "all";
const T0 = 1_700_000_000_000;
const desc = LeaderboardBoard.parse({ key: "high", direction: "desc" });
const asc = LeaderboardBoard.parse({ key: "fast", direction: "asc" });

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

interface Seed {
  userId: string;
  score: number;
  /** ms after T0. */
  at: number;
  visible?: boolean;
  hidden?: boolean;
}

async function seed(board: LeaderboardBoard, rows: Seed[]): Promise<void> {
  const store = entryStore(db());
  for (const row of rows) {
    await store.submit(board, WINDOW, row.userId, row.score, new Date(T0 + row.at), row.visible ?? true);
    if (row.hidden) await store.hide(board.key, WINDOW, row.userId, true);
  }
}

/** Walk every page of the window at `limit`, and return each page's rows as `userId:rank`. */
async function walk(board: LeaderboardBoard, limit: number, query: Omit<EntriesQuery, "cursor" | "limit"> = {}) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await listEntries(db(), board, WINDOW, { ...query, limit, ...(cursor ? { cursor } : {}) });
    pages.push(page.items.map((item: AdminEntry) => `${item.entry.userId}:${item.rank ?? "-"}`));
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("the listing never ended");
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

describe("listEntries — ties at a page boundary", () => {
  // Five players on one score: three reached it at the same instant (only `userId` orders them), two later
  // (`achievedAt` orders them first). Inserted out of order, so the order below is the query's, not SQLite's.
  const tied: Seed[] = [
    { userId: "e", score: 50, at: 2000 },
    { userId: "c", score: 50, at: 1000 },
    { userId: "a", score: 50, at: 1000 },
    { userId: "d", score: 50, at: 3000 },
    { userId: "b", score: 50, at: 1000 },
    { userId: "top", score: 60, at: 9000 },
    { userId: "low", score: 10, at: 0 },
  ];
  const order = ["top", "a", "b", "c", "e", "d", "low"];

  test("one row a page walks every entry once, in order, through every tiebreak", async () => {
    await seed(desc, tied);
    const pages = await walk(desc, 1);
    expect(pages.flat().map((row) => row.split(":")[0])).toEqual(order);
    expect(pages.every((page) => page.length === 1)).toBe(true);
  });

  test("a page boundary inside the tie neither skips nor repeats a row, at any page size", async () => {
    await seed(desc, tied);
    for (const limit of [2, 3, 4]) {
      expect((await walk(desc, limit)).flat().map((row) => row.split(":")[0])).toEqual(order);
    }
  });

  test("ranks run on across pages without a gap", async () => {
    await seed(desc, tied);
    expect((await walk(desc, 2)).flat()).toEqual(order.map((userId, i) => `${userId}:${i + 1}`));
  });
});

describe("listEntries — an ascending board", () => {
  test("lowest score first, and a tie on it pages by achievedAt then userId", async () => {
    await seed(asc, [
      { userId: "slow", score: 90, at: 0 },
      { userId: "late", score: 30, at: 5000 },
      { userId: "z", score: 30, at: 1000 },
      { userId: "y", score: 30, at: 1000 },
      { userId: "mid", score: 45, at: 0 },
    ]);
    const pages = await walk(asc, 2);
    expect(pages).toEqual([["y:1", "z:2"], ["late:3", "mid:4"], ["slow:5"]]);
  });
});

describe("listEntries — rows that are not on the board", () => {
  // Hidden by a moderator, or never consented: each sits where its score puts it, with no rank, and takes no
  // position from the rows after it.
  const mixed: Seed[] = [
    { userId: "u1", score: 100, at: 0 },
    { userId: "u2", score: 90, at: 0, hidden: true },
    { userId: "u3", score: 80, at: 0, visible: false },
    { userId: "u4", score: 70, at: 0 },
    { userId: "u5", score: 70, at: 0, hidden: true },
    { userId: "u6", score: 70, at: 0 },
  ];

  test("an unranked row at a page boundary does not shift the next page's ranks", async () => {
    await seed(desc, mixed);
    expect(await walk(desc, 2)).toEqual([
      ["u1:1", "u2:-"],
      ["u3:-", "u4:2"],
      ["u5:-", "u6:3"],
    ]);
  });

  test("a page that starts on unranked rows counts its first ranked row live", async () => {
    await seed(desc, mixed);
    expect(await walk(desc, 3)).toEqual([
      ["u1:1", "u2:-", "u3:-"],
      ["u4:2", "u5:-", "u6:3"],
    ]);
  });

  test("hidden: false leaves out what a moderator hid, and keeps an unconsented row in place", async () => {
    await seed(desc, mixed);
    expect(await walk(desc, 1, { hidden: false })).toEqual([["u1:1"], ["u3:-"], ["u4:2"], ["u6:3"]]);
  });

  test("hidden: true is only what a moderator hid, unranked", async () => {
    await seed(desc, mixed);
    expect(await walk(desc, 1, { hidden: true })).toEqual([["u2:-"], ["u5:-"]]);
  });

  test("userId narrows to one player's entry, ranked as the board ranks it", async () => {
    await seed(desc, mixed);
    expect(await walk(desc, 5, { userId: "u6" })).toEqual([["u6:3"]]);
  });
});
