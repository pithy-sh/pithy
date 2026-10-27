// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { moderateEntry } from "../admin/moderate";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { type LeaderboardBoard, LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { LEADERBOARD_STALE_WINDOWS_TABLE, leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { windowKeyAt } from "../window/schedule";
import { RANK_CHUNK_SIZE } from "./materialize";
import { runRankPass } from "./worker";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const DAILY = "0 0 * * *";

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

const config = (input: LeaderboardConfigInput) => LeaderboardConfig.parse(input);

/** The nth configured board. Throws rather than asserting non-null, so a bad index fails as a test bug. */
function boardAt(c: LeaderboardConfig, index: number): LeaderboardBoard {
  const found = c.boards[index];
  if (!found) throw new Error(`test config has no board at index ${index}`);
  return found;
}

/**
 * A D1 that refuses every statement bound to one board's key — a table this board's query touches gone,
 * a read the account stopped answering. Everything else goes to the real database.
 *
 * Wrapped rather than mocked so the sibling boards run against real D1 through Kysely exactly as they do
 * in production; only the one board's round trip is poisoned.
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
      if (values.includes(boardKey as never)) {
        throw new Error(`D1_ERROR: no such column: rank_of_${boardKey} at offset 42`);
      }
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

describe("runRankPass", () => {
  test("prunes closed windows past retain, even when rank is live", async () => {
    // Retention is why a live board set with windows still deploys this worker.
    const c = config({ boards: [{ key: "b1", direction: "desc", window: DAILY, retain: 1 }] });
    const store = entryStore(leaderboardDatabase(env.DB));
    const b = boardAt(c, 0);
    for (let i = 0; i < 5; i++) {
      const day = new Date(NOW.getTime() - i * 86_400_000);
      await store.submit(b, windowKeyAt(DAILY, day), "u1", 10, day, true);
    }
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.pruned).toEqual({ state: "pruned", deleted: 3 });
    expect(result.refreshed).toEqual([]);
  });

  test("refreshes the open window's ranks when the board is materialized", async () => {
    const c = config({ boards: [{ key: "b1", direction: "desc" }], rank: { materialize: "0 * * * *" } });
    const store = entryStore(leaderboardDatabase(env.DB));
    for (let i = 0; i < 5; i++) await store.submit(boardAt(c, 0), "all", `u${i}`, 100 - i, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed).toEqual([
      { state: "refreshed", board: "b1", window: "all", ranked: 5, chunks: 1, complete: true, cursor: null },
    ]);
    const { results } = await env.DB.prepare(
      "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE user_id = 'u0'",
    ).all<{ rank: number }>();
    expect(results[0]?.rank).toBe(1);
  });

  test("refreshes only the open window, since a closed window's ranks stopped moving", async () => {
    const c = config({
      boards: [{ key: "b1", direction: "desc", window: DAILY, retain: 5 }],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    const closed = windowKeyAt(DAILY, new Date(NOW.getTime() - 86_400_000));
    await store.submit(boardAt(c, 0), closed, "u1", 10, NOW, true);
    await store.submit(boardAt(c, 0), windowKeyAt(DAILY, NOW), "u2", 10, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed.map((r) => r.window)).toEqual([windowKeyAt(DAILY, NOW)]);
  });

  describe("a closed window an act moved", () => {
    // Cheating usually turns up after the week it happened in, so an act on a closed window is the common
    // case, and the pass that only renumbers the open window would leave its stored ranks wrong for good.
    const c = config({
      boards: [{ key: "b1", direction: "desc", window: DAILY, retain: 5 }],
      rank: { materialize: "0 * * * *" },
    });
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const closed = windowKeyAt(DAILY, yesterday);
    const ranks = async () => {
      const { results } = await env.DB.prepare(
        "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE window_key = ? ORDER BY user_id",
      )
        .bind(closed)
        .all<{ user_id: string; rank: number | null }>();
      return Object.fromEntries(results.map((row) => [row.user_id, row.rank]));
    };
    const moderate = (act: "hide" | "correct", userId: string, score?: number) =>
      moderateEntry(env.DB, {
        act,
        board: boardAt(c, 0),
        windowKey: closed,
        userId,
        ...(score === undefined ? {} : { score }),
        idempotencyKey: `${act}-${userId}`,
        reason: "Found after the day closed.",
        actor: { connectionId: "c1", actorId: "operator-1" },
        materialized: true,
        now: NOW,
      });

    beforeEach(async () => {
      const store = entryStore(leaderboardDatabase(env.DB));
      for (const [userId, score] of [
        ["u1", 100],
        ["u2", 90],
        ["u3", 80],
      ] as const) {
        await store.submit(boardAt(c, 0), closed, userId, score, yesterday, true);
      }
      // The pass that ran while the window was open left it ranked.
      await runRankPass(env.DB, c, yesterday);
      expect(await ranks()).toEqual({ u1: 1, u2: 2, u3: 3 });
    });

    test("hiding its #1 renumbers everyone below on the next pass", async () => {
      await moderate("hide", "u1");
      const result = await runRankPass(env.DB, c, NOW);
      expect(await ranks()).toEqual({ u1: null, u2: 1, u3: 2 });
      expect(result.refreshed.map((r) => r.window)).toEqual([windowKeyAt(DAILY, NOW), closed]);
    });

    test("a correction gets its rank back on the next pass, rather than none for good", async () => {
      await moderate("correct", "u3", 200);
      expect((await ranks()).u3).toBeNull();
      await runRankPass(env.DB, c, NOW);
      expect(await ranks()).toEqual({ u1: 2, u2: 3, u3: 1 });
    });

    test("is renumbered once: the pass clears what it renumbered", async () => {
      await moderate("hide", "u1");
      await runRankPass(env.DB, c, NOW);
      expect(
        await leaderboardDatabase(env.DB).selectFrom(LEADERBOARD_STALE_WINDOWS_TABLE).selectAll().execute(),
      ).toEqual([]);
      const again = await runRankPass(env.DB, c, NOW);
      expect(again.refreshed.map((r) => r.window)).toEqual([windowKeyAt(DAILY, NOW)]);
    });
  });

  test("refreshes every board", async () => {
    const c = config({
      boards: [
        { key: "b1", direction: "desc" },
        { key: "b2", direction: "asc" },
      ],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    await store.submit(boardAt(c, 0), "all", "u1", 10, NOW, true);
    await store.submit(boardAt(c, 1), "all", "u1", 10, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed.map((r) => r.board)).toEqual(["b1", "b2"]);
  });

  test("ranks every board to completion across many chunks — no per-invocation ceiling", async () => {
    // The old design capped a run and left the tail stale; runRankPass now completes each board fully.
    const c = config({
      boards: [
        { key: "b1", direction: "desc" },
        { key: "b2", direction: "desc" },
      ],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    const big = RANK_CHUNK_SIZE * 3 + 5;
    for (let i = 0; i < big; i++)
      await store.submit(boardAt(c, 0), "all", `u${String(i).padStart(4, "0")}`, i, NOW, true);
    await store.submit(boardAt(c, 1), "all", "v1", 1, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(
      result.refreshed.map((r) =>
        r.state === "refreshed" ? [r.board, r.ranked, r.complete] : [r.board, "unavailable"],
      ),
    ).toEqual([
      ["b1", big, true],
      ["b2", 1, true],
    ]);
    // The tail of the big board actually got a rank — it is not stale. `u0000` has the lowest score
    // (0), so on a desc board it sits in last place, rank `big`. If the pass had a ceiling, it would be
    // null.
    const { results } = await env.DB.prepare(
      "SELECT rank FROM pithy_leaderboard_entries WHERE board_id='b1' AND user_id='u0000'",
    ).all<{ rank: number }>();
    expect(results[0]?.rank).toBe(big);
  });

  /**
   * The #371 gate. One board's refresh throws; the pass keeps every sibling and the sweep beside them.
   *
   * Asserted on the value in both directions the issue asks for: the sibling board's numbers are still
   * there (it was not blanked), and the sick board does not read as a board that ranked nobody.
   */
  test("a board whose refresh throws costs its own entry, never its siblings", async () => {
    const c = config({
      boards: [
        { key: "b1", direction: "desc" },
        { key: "b2", direction: "desc" },
      ],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    await store.submit(boardAt(c, 0), "all", "u1", 10, NOW, true);
    await store.submit(boardAt(c, 1), "all", "v1", 10, NOW, true);

    const result = await runRankPass(d1RefusingBoard(env.DB, "b1"), c, NOW);

    expect(result.refreshed).toEqual([
      { state: "unavailable", board: "b1", window: "all" },
      { state: "refreshed", board: "b2", window: "all", ranked: 1, chunks: 1, complete: true, cursor: null },
    ]);
    // The sick board is not a board that ranked nobody: `unavailable` carries no `ranked` at all, so no
    // consumer can read a zero off it.
    const sick = result.refreshed[0];
    expect(sick?.state).toBe("unavailable");
    expect(sick && "ranked" in sick).toBe(false);
    // The sweep beside it still reported.
    expect(result.pruned).toEqual({ state: "pruned", deleted: 0 });
    // And nothing the D1 failure said travels.
    expect(JSON.stringify(result)).not.toMatch(/rank_of_|offset 42|D1_ERROR/);
  });

  test("does nothing on an all-time live board set — the case that needs no worker at all", async () => {
    const c = config({ boards: [{ key: "b1", direction: "desc" }] });
    await entryStore(leaderboardDatabase(env.DB)).submit(boardAt(c, 0), "all", "u1", 10, NOW, true);
    expect(await runRankPass(env.DB, c, NOW)).toEqual({ pruned: { state: "pruned", deleted: 0 }, refreshed: [] });
  });
});
