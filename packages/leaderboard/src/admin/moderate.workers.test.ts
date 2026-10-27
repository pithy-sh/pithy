// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardBoard } from "../config/config";
import { LEADERBOARD_MODERATIONS_TABLE, LEADERBOARD_STALE_WINDOWS_TABLE, leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { acquireRefreshLock } from "../rank/lock";
import { windowKeyAt } from "../window/schedule";
import { clearLock, type EntryActInput, moderateEntry } from "./moderate";

/**
 * The acts' own logic (#817): what a reused key answers, the races an act's write is arranged to survive,
 * what a correction takes over, and which windows an act leaves for the refresh to renumber. The HTTP suite
 * proves the routes; this one reaches the branches a request cannot be timed or shaped to reach, so a D1
 * wrapper runs an interloper just before the act's write.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const board = LeaderboardBoard.parse({ key: "high", direction: "desc", aggregation: "sum" });
const actor = { connectionId: "c1", actorId: "operator-1" };

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

/** `env.DB`, with `interloper` run once just before the next batch — between the act's read and write. */
function interrupted(interloper: () => Promise<unknown>): D1Database {
  let pending: (() => Promise<unknown>) | null = interloper;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Parameters<D1Database["batch"]>[0]) => {
          const run = pending;
          pending = null;
          if (run) await run();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `env.DB`, with `interloper` run once just before the first statement whose SQL matches `pattern` runs —
 * for a write that is a single statement rather than a batch.
 */
function interruptedAt(pattern: RegExp, interloper: () => Promise<unknown>): D1Database {
  let pending: (() => Promise<unknown>) | null = interloper;
  const settle = async () => {
    const run = pending;
    pending = null;
    if (run) await run();
  };
  const watch = <T extends object>(statement: T): T =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => watch(value.apply(target, args));
        if (["all", "run", "first", "raw"].includes(String(property))) {
          return async (...args: unknown[]) => {
            await settle();
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return pending && pattern.test(query) ? watch(statement) : statement;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const db = () => leaderboardDatabase(env.DB);
const store = () => entryStore(db());
const historyCount = async () => (await db().selectFrom(LEADERBOARD_MODERATIONS_TABLE).select("id").execute()).length;

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
  await store().submit(board, "all", "ann", 50, NOW, true);
});

const act = (d1: D1Database, overrides: Partial<EntryActInput> = {}) =>
  moderateEntry(d1, {
    act: "hide",
    board,
    windowKey: "all",
    userId: "ann",
    idempotencyKey: "k1",
    reason: "Impossible run.",
    actor,
    materialized: false,
    now: NOW,
    ...overrides,
  });

const hide = (d1: D1Database, idempotencyKey = "k1") => act(d1, { idempotencyKey });

const staleWindows = async () =>
  db().selectFrom(LEADERBOARD_STALE_WINDOWS_TABLE).select(["boardId", "windowKey"]).execute();

describe("moderateEntry with a key already used", () => {
  const other = LeaderboardBoard.parse({ key: "low", direction: "asc" });

  const cases: [string, { board: LeaderboardBoard; windowKey: string; userId: string }][] = [
    ["a different board", { board: other, windowKey: "all", userId: "ann" }],
    ["a different window", { board, windowKey: "2026-06-01T00:00:00.000Z", userId: "ann" }],
    ["a different player", { board, windowKey: "all", userId: "bob" }],
  ];
  test.each(cases)("is a 409 for the same act on %s, and the second entry is never touched", async (_name, target) => {
    await store().submit(other, "all", "ann", 7, NOW, true);
    await store().submit(board, "2026-06-01T00:00:00.000Z", "ann", 9, NOW, true);
    await store().submit(board, "all", "bob", 3, NOW, true);
    await hide(env.DB);

    await expect(act(env.DB, target)).rejects.toMatchObject({ payload: { code: "core/conflict", status: 409 } });

    expect(await historyCount()).toBe(1);
    const second = await store().get(target.board.key, target.windowKey, target.userId);
    expect(second?.hidden).toBe(false);
  });

  test("tells the caller, in the message, to mint a new key", async () => {
    await hide(env.DB);
    const reused = act(env.DB, { act: "unhide" });
    await expect(reused).rejects.toMatchObject({ payload: { message: expect.stringMatching(/new idempotency key/) } });
  });

  test("a lock clear is a 409 for a key first used on an entry, and the lock stays held", async () => {
    await acquireRefreshLock(db(), "instance-7", NOW);
    await hide(env.DB);
    const clear = clearLock(env.DB, {
      name: "rank-refresh",
      holder: "instance-7",
      idempotencyKey: "k1",
      reason: "Crashed.",
      actor,
      now: NOW,
    });
    await expect(clear).rejects.toMatchObject({ payload: { code: "core/conflict", status: 409 } });
    expect(await historyCount()).toBe(1);
    expect(await db().selectFrom("pithyLeaderboardLocks").select("holder").execute()).toEqual([
      { holder: "instance-7" },
    ]);
  });

  test("a lock clear is a 409 for a key first used on a different lock", async () => {
    await acquireRefreshLock(db(), "instance-7", NOW);
    const first = { holder: "instance-7", idempotencyKey: "k9", reason: "Crashed.", actor, now: NOW };
    await clearLock(env.DB, { ...first, name: "rank-refresh" });
    await expect(clearLock(env.DB, { ...first, name: "other-lock" })).rejects.toMatchObject({
      payload: { code: "core/conflict", status: 409 },
    });
    expect(await historyCount()).toBe(1);
  });
});

describe("moderateEntry with no window named", () => {
  const daily = LeaderboardBoard.parse({ key: "daily", direction: "desc", window: "0 0 * * *" });
  const lateMonday = new Date("2026-06-08T23:59:59.900Z");
  const earlyTuesday = new Date("2026-06-09T00:00:01.000Z");

  test("acts on the window open now, and says which", async () => {
    await store().submit(daily, windowKeyAt(daily.window, lateMonday), "ann", 5, lateMonday, true);
    const outcome = await act(env.DB, { board: daily, windowKey: undefined, now: lateMonday });
    expect(outcome.windowKey).toBe(windowKeyAt(daily.window, lateMonday));
  });

  test("a retry across the rollover is the replay of the first, not a 409 aimed at the next day", async () => {
    // The bug: the retry recomputed the window from its own clock, judged the key used for another act, and
    // told the client to mint a new key — which would have hidden the entry in the wrong window.
    const monday = windowKeyAt(daily.window, lateMonday);
    await store().submit(daily, monday, "ann", 5, lateMonday, true);
    await store().submit(daily, windowKeyAt(daily.window, earlyTuesday), "ann", 6, earlyTuesday, true);
    await act(env.DB, { board: daily, windowKey: undefined, now: lateMonday });

    const retry = await act(env.DB, { board: daily, windowKey: undefined, now: earlyTuesday });

    expect(retry).toMatchObject({ replayed: true, windowKey: monday });
    expect(await historyCount()).toBe(1);
    expect((await store().get("daily", windowKeyAt(daily.window, earlyTuesday), "ann"))?.hidden).toBe(false);
  });
});

describe("moderateEntry on a correction", () => {
  test("takes the entry over: its contributions go and it names no result", async () => {
    await env.DB.exec(
      "INSERT INTO pithy_leaderboard_contributions (result_id, board_id, window_key, user_id, score, aggregation, created_at) VALUES ('r1', 'high', 'all', 'ann', 50, 'sum', 1)",
    );
    await env.DB.exec("UPDATE pithy_leaderboard_entries SET result_id = 'r1'");

    await act(env.DB, { act: "correct", score: 4 });

    const entry = await store().get("high", "all", "ann");
    expect(entry).toMatchObject({ score: 4, resultId: null });
    expect(await db().selectFrom("pithyLeaderboardContributions").select("id").execute()).toEqual([]);
  });

  test("a correction that loses its race takes nothing over", async () => {
    await env.DB.exec(
      "INSERT INTO pithy_leaderboard_contributions (result_id, board_id, window_key, user_id, score, aggregation, created_at) VALUES ('r1', 'high', 'all', 'ann', 50, 'sum', 1)",
    );
    const racing = act(
      interrupted(() => store().submit(board, "all", "ann", 5, NOW, true)),
      { act: "correct", score: 4 },
    );
    await expect(racing).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect(await db().selectFrom("pithyLeaderboardContributions").select("id").execute()).toHaveLength(1);
  });
});

describe("moderateEntry and the stored rank", () => {
  test("on a materialized board, marks the window it changed stale for the next refresh", async () => {
    await act(env.DB, { materialized: true, windowKey: "all" });
    expect(await staleWindows()).toEqual([{ boardId: "high", windowKey: "all" }]);
  });

  test("on a live board, marks nothing — there is no stored rank to renumber", async () => {
    await hide(env.DB);
    expect(await staleWindows()).toEqual([]);
  });

  test("an act that changed nothing marks nothing", async () => {
    await act(env.DB, { act: "unhide", materialized: true });
    expect(await staleWindows()).toEqual([]);
  });
});

describe("moderateEntry under a race", () => {
  test("a request with the same key that wins in between makes this one its replay", async () => {
    const outcome = await hide(interrupted(() => hide(env.DB)));
    expect(outcome.replayed).toBe(true);
    expect(outcome.after.hidden).toBe(true);
    expect(await historyCount()).toBe(1);
  });

  test("a submission landing in between is a 409 to retry, and nothing is recorded", async () => {
    const correct = moderateEntry(
      interrupted(() => store().submit(board, "all", "ann", 5, NOW, true)),
      {
        act: "correct",
        board,
        windowKey: "all",
        userId: "ann",
        score: 10,
        idempotencyKey: "k1",
        reason: "Typo.",
        actor,
        materialized: false,
        now: NOW,
      },
    );
    await expect(correct).rejects.toMatchObject({
      payload: { code: "core/conflict", status: 409, message: expect.stringMatching(/same idempotency key/) },
    });
    // The submission stands, and no history claims a correction from a score nobody saw.
    expect((await store().get("high", "all", "ann"))?.score).toBe(55);
    expect(await historyCount()).toBe(0);
  });

  test("an act that changes nothing and loses its key to a racing twin is that twin's replay", async () => {
    const unhide = (d1: D1Database) => act(d1, { act: "unhide" });
    const outcome = await unhide(interruptedAt(/^insert into "pithy_leaderboard_moderations"/i, () => unhide(env.DB)));
    expect(outcome).toMatchObject({ changed: false, replayed: true });
    expect(await historyCount()).toBe(1);
  });

  test("an act that changes nothing and loses its key to a different act is a 409", async () => {
    const outcome = act(
      interruptedAt(/^insert into "pithy_leaderboard_moderations"/i, () => hide(env.DB)),
      { act: "unhide" },
    );
    await expect(outcome).rejects.toMatchObject({ payload: { code: "core/conflict", status: 409 } });
    expect(await historyCount()).toBe(1);
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(true);
  });
});

describe("clearLock under a race", () => {
  const clear = (d1: D1Database) =>
    clearLock(d1, {
      name: "rank-refresh",
      holder: "instance-7",
      idempotencyKey: "k1",
      reason: "Crashed.",
      actor,
      now: NOW,
    });

  test("a lock taken over in between is a 409, and the new holder keeps it", async () => {
    const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    await acquireRefreshLock(db(), "instance-7", NOW);
    const racing = clear(interrupted(() => acquireRefreshLock(db(), "instance-8", later)));
    await expect(racing).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect(await historyCount()).toBe(0);
  });

  test("a lock released in between is a 404", async () => {
    await acquireRefreshLock(db(), "instance-7", NOW);
    const racing = clear(interrupted(() => env.DB.exec("DELETE FROM pithy_leaderboard_locks")));
    await expect(racing).rejects.toMatchObject({ payload: { code: "core/not_found" } });
  });
});
