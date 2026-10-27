// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import "../algorithm/builtins";
import { RATING_MIGRATION_ORDER, rating } from "../capability";
import { RatingConfig, type RatingConfigInput, resolveGame, resolvePool, validateRatingGames } from "../config/config";
import { outcomeLog } from "../data/log";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { voidResult } from "../history/void";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import { recordOutcome } from "../record/record";
import { adjustRating, type RatingActRequest } from "./acts";

/**
 * The acts and the void, against real D1 and every built-in algorithm.
 *
 * The replay's own suite proves the walk with a stub. This proves the whole path — the log written in the
 * transaction that moved the rating, read back through its schema, replayed through Elo, Glicko-2 and
 * TrueSkill, and written again — lands on the rating live application left.
 */

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "rating",
      order: RATING_MIGRATION_ORDER,
      migrations: { "0001_rating": rating_0001_rating, "0002_outcome_log": rating_0002_outcome_log },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

const TABLES = [
  "pithy_rating_ratings",
  "pithy_rating_outcomes",
  "pithy_rating_outcome_players",
  "pithy_rating_adjustments",
  "pithy_migrations",
  "pithy_migrations_lock",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await runMigrations(env.DB, provider());
});

const XP = { win: 20, draw: 10, loss: 5 };
const CONFIG: RatingConfigInput = {
  games: [
    { key: "elo", algorithm: "elo", xp: XP },
    { key: "glicko", algorithm: "glicko", xp: XP },
    { key: "trueskill", algorithm: "trueskill", players: 3, xp: XP },
    { key: "teams", algorithm: "trueskill", players: 4, teams: true, pool: "trueskill", xp: XP },
    { key: "elo-control", algorithm: "elo", xp: XP },
  ],
};
const GAMES = validateRatingGames(RatingConfig.parse(CONFIG));
const db = () => ratingDatabase(env.DB);
const at = new Date("2026-10-20T12:00:00.000Z");
const later = new Date("2026-10-21T12:00:00.000Z");

function game(key: string) {
  const found = resolveGame(GAMES, key);
  if (!found) throw new Error(`no game ${key}`);
  return found;
}

function pool(name: string) {
  const found = resolvePool(GAMES, name);
  if (!found) throw new Error(`no pool ${name}`);
  return found;
}

async function play(
  key: string,
  ranks: Record<string, number>,
  extra: { resultId?: string; teams?: Record<string, string> } = {},
) {
  return recordOutcome(ratingStore(db()), game(key), { ranks, at, ...extra });
}

function act(overrides: Partial<RatingActRequest> & Pick<RatingActRequest, "act" | "userId">): RatingActRequest {
  return { pool: pool("elo"), idempotencyKey: crypto.randomUUID(), reason: "Support ticket 4411.", ...overrides };
}

async function stored(poolName: string, userId: string) {
  const row = await ratingStore(db()).get(poolName, userId);
  if (!row) throw new Error(`no rating for ${userId}`);
  return row;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("the outcome log", () => {
  test("every applied outcome is appended, with its result id when one is given", async () => {
    await play("elo", { ada: 1, bob: 2 }, { resultId: "match-1" });
    await play("elo", { ada: 2, bob: 1 });

    const rows = await env.DB.prepare(
      "SELECT pool, game, result_id, ranks FROM pithy_rating_outcomes ORDER BY id",
    ).all<{ pool: string; game: string; result_id: string | null; ranks: string }>();
    expect(rows.results).toEqual([
      { pool: "elo", game: "elo", result_id: "match-1", ranks: JSON.stringify({ ada: 1, bob: 2 }) },
      { pool: "elo", game: "elo", result_id: null, ranks: JSON.stringify({ ada: 2, bob: 1 }) },
    ]);
    const ada = await outcomeLog(db()).playerEntries("elo", "ada");
    expect(ada.map((entry) => [entry.gamesBefore, entry.xpBefore, entry.xpGained])).toEqual([
      [0, 0, 20],
      [1, 20, 5],
    ]);
    expect(ada[0]?.stateBefore).toEqual({ rating: 1500 });
    expect(ada[1]?.stateBefore).not.toEqual({ rating: 1500 });
  });
});

describe("recalculate", () => {
  const cases: { name: string; pool: string; games: [string, Record<string, number>, Record<string, string>?][] }[] = [
    {
      name: "elo",
      pool: "elo",
      games: [
        ["elo", { ada: 1, bob: 2 }],
        ["elo", { bob: 1, cy: 2 }],
        ["elo", { cy: 1, ada: 2 }],
        ["elo", { ada: 1, cy: 1 }],
        ["elo", { bob: 1, ada: 2 }],
      ],
    },
    {
      name: "glicko",
      pool: "glicko",
      games: [
        ["glicko", { ada: 1, bob: 2 }],
        ["glicko", { bob: 1, cy: 2 }],
        ["glicko", { cy: 1, ada: 2 }],
        ["glicko", { ada: 1, cy: 1 }],
        ["glicko", { bob: 1, ada: 2 }],
      ],
    },
    {
      name: "trueskill, free-for-all and teams in one pool",
      pool: "trueskill",
      games: [
        ["trueskill", { ada: 1, bob: 2, cy: 3 }],
        ["trueskill", { cy: 1, ada: 2, bob: 3 }],
        ["teams", { ada: 1, bob: 1, cy: 2, dan: 2 }, { ada: "red", bob: "red", cy: "blue", dan: "blue" }],
        ["trueskill", { dan: 1, bob: 2, ada: 2 }],
      ],
    },
  ];

  for (const { name, pool: poolName, games } of cases) {
    test(`replays to exactly the rating live application left — ${name}`, async () => {
      for (const [key, ranks, teams] of games) await play(key, ranks, teams ? { teams } : {});
      for (const userId of ["ada", "bob", "cy", ...(poolName === "trueskill" ? ["dan"] : [])]) {
        const live = await stored(poolName, userId);
        const { adjustment, replayed } = await adjustRating(
          db(),
          GAMES,
          act({ act: "recalculate", userId, pool: pool(poolName) }),
          later,
        );
        expect(replayed).toBe(false);
        expect(adjustment.after, `${name}: ${userId}`).toEqual({
          algorithm: live.algorithm,
          state: live.state,
          skill: live.skill,
          xp: live.xp,
          games: live.games,
        });
        expect(adjustment.before?.skill).toBe(live.skill);
        expect((await stored(poolName, userId)).skill).toBe(live.skill);
      }
    });
  }

  test("a rating with no logged outcome is refused, naming that it predates its history", async () => {
    await ratingStore(db()).upsert({
      id: 0,
      pool: "elo",
      userId: "veteran",
      algorithm: "elo",
      state: { rating: 1720 },
      skill: 1720,
      xp: 300,
      games: 40,
      updatedAt: at,
    });
    await expect(adjustRating(db(), GAMES, act({ act: "recalculate", userId: "veteran" }), later)).rejects.toThrow(
      /predates its history/,
    );
    expect(await count("pithy_rating_adjustments")).toBe(0);
    expect((await stored("elo", "veteran")).skill).toBe(1720);
  });

  test("a player with no rating in the pool is a 404", async () => {
    await expect(adjustRating(db(), GAMES, act({ act: "recalculate", userId: "nobody" }), later)).rejects.toMatchObject(
      {
        payload: { code: "core/not_found" },
      },
    );
  });
});

describe("reset", () => {
  test("returns the player to the algorithm's starting state, and keeps the prior rating on the act", async () => {
    await play("elo", { ada: 1, bob: 2 });
    await play("elo", { ada: 1, bob: 2 });
    const prior = await stored("elo", "ada");

    const { adjustment } = await adjustRating(db(), GAMES, act({ act: "reset", userId: "ada" }), later);

    expect(adjustment.before).toEqual({
      algorithm: "elo",
      state: prior.state,
      skill: prior.skill,
      xp: prior.xp,
      games: prior.games,
    });
    expect(adjustment.after).toEqual({ algorithm: "elo", state: { rating: 1500 }, skill: 1500, xp: 40, games: 2 });
    expect(await stored("elo", "ada")).toMatchObject({ skill: 1500, state: { rating: 1500 }, xp: 40, games: 2 });
  });

  test("a recalculation after a reset replays from the reset, not through it", async () => {
    await play("elo", { ada: 1, bob: 2 });
    await adjustRating(db(), GAMES, act({ act: "reset", userId: "ada" }), later);
    await play("elo", { ada: 1, bob: 2 });
    const live = await stored("elo", "ada");

    const { adjustment } = await adjustRating(db(), GAMES, act({ act: "recalculate", userId: "ada" }), later);
    expect(adjustment.after.state).toEqual(live.state);
    expect(adjustment.after.games).toBe(2);
  });
});

describe("idempotency", () => {
  test("a replayed key changes nothing and answers with what the first request did", async () => {
    await play("elo", { ada: 1, bob: 2 });
    const request = act({ act: "reset", userId: "ada" });
    const first = await adjustRating(db(), GAMES, request, later);
    await play("elo", { ada: 1, bob: 2 });
    const between = await stored("elo", "ada");

    const second = await adjustRating(db(), GAMES, request, new Date("2026-10-22T00:00:00.000Z"));

    expect(second.replayed).toBe(true);
    expect(second.adjustment).toEqual(first.adjustment);
    expect(await stored("elo", "ada")).toEqual(between);
    expect(await count("pithy_rating_adjustments")).toBe(1);
  });

  test("two requests with one key in flight at once: one acts, the other replays", async () => {
    await play("elo", { ada: 1, bob: 2 });
    const request = act({ act: "reset", userId: "ada" });
    const results = await Promise.all([
      adjustRating(db(), GAMES, request, later),
      adjustRating(db(), GAMES, request, later),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await count("pithy_rating_adjustments")).toBe(1);
  });

  test("a request that loses the race after its spent-key read answers with the winner's act", async () => {
    await play("elo", { ada: 1, bob: 2 });
    const request = act({ act: "reset", userId: "ada" });
    const winnerAt = new Date("2026-10-21T08:00:00.000Z");
    let batches = 0;
    // The winner commits between this request's spent-key read and its batch, deterministically: the
    // batch is the only place left to find the key spent, so the answer has to come from the catch.
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: Parameters<typeof target.batch>[0]) => {
            batches++;
            await adjustRating(ratingDatabase(env.DB), GAMES, request, winnerAt);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await adjustRating(ratingDatabase(racing), GAMES, request, later);

    expect(batches).toBe(1);
    expect(result.replayed).toBe(true);
    expect(result.adjustment.at).toEqual(winnerAt);
    expect(await count("pithy_rating_adjustments")).toBe(1);
  });

  test("a batch that fails for any other reason is not taken for a lost race", async () => {
    await play("elo", { ada: 1, bob: 2 });
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return async () => Promise.reject(new Error("D1_ERROR: disk I/O error"));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      adjustRating(ratingDatabase(failing), GAMES, act({ act: "reset", userId: "ada" }), later),
    ).rejects.toThrow(/disk I\/O error/);
    expect(await count("pithy_rating_adjustments")).toBe(0);
  });

  test("a key spent on a different act is refused, not answered", async () => {
    await play("elo", { ada: 1, bob: 2 });
    const key = crypto.randomUUID();
    await adjustRating(db(), GAMES, act({ act: "reset", userId: "ada", idempotencyKey: key }), later);
    await expect(
      adjustRating(db(), GAMES, act({ act: "recalculate", userId: "ada", idempotencyKey: key }), later),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    await expect(
      adjustRating(db(), GAMES, act({ act: "reset", userId: "bob", idempotencyKey: key }), later),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
  });
});

describe("voidResult", () => {
  test("marks the outcome void and recalculates every player it touched, reporting before and after", async () => {
    await play("elo", { ada: 1, bob: 2 }, { resultId: "r-1" });
    await play("elo", { ada: 1, cy: 2 }, { resultId: "r-2" });
    await play("elo", { dan: 1, ada: 2 }, { resultId: "r-3" });
    // The same games without the voided one, in a pool of their own: what ada and cy should come to.
    await play("elo-control", { ada: 1, bob: 2 });
    await play("elo-control", { dan: 1, ada: 2 });
    const adaBefore = await stored("elo", "ada");
    const cyBefore = await stored("elo", "cy");

    const report = await voidResult(db(), GAMES, "r-2", later);

    expect(report.resultId).toBe("r-2");
    expect(report.outcomes).toBe(1);
    expect(report.players.map((player) => player.userId).sort()).toEqual(["ada", "cy"]);
    const control = await stored("elo-control", "ada");
    const ada = report.players.find((player) => player.userId === "ada");
    expect(ada?.before?.skill).toBe(adaBefore.skill);
    expect(ada?.after).toEqual({ algorithm: "elo", state: control.state, skill: control.skill, xp: 25, games: 2 });
    const cy = report.players.find((player) => player.userId === "cy");
    expect(cy?.before?.skill).toBe(cyBefore.skill);
    expect(cy?.after).toEqual({ algorithm: "elo", state: { rating: 1500 }, skill: 1500, xp: 0, games: 0 });
    expect((await stored("elo", "ada")).skill).toBe(control.skill);

    const voided = await env.DB.prepare("SELECT result_id, voided_at FROM pithy_rating_outcomes ORDER BY id").all<{
      result_id: string | null;
      voided_at: number | null;
    }>();
    expect(voided.results.filter((row) => row.voided_at !== null).map((row) => row.result_id)).toEqual(["r-2"]);
  });

  test("voiding a voided result, or one rating never saw, changes nothing", async () => {
    await play("elo", { ada: 1, bob: 2 }, { resultId: "r-1" });
    await voidResult(db(), GAMES, "r-1", later);
    const after = await stored("elo", "ada");

    expect(await voidResult(db(), GAMES, "r-1", new Date("2026-10-23T00:00:00.000Z"))).toEqual({
      resultId: "r-1",
      outcomes: 0,
      players: [],
    });
    expect(await voidResult(db(), GAMES, "never-recorded", later)).toEqual({
      resultId: "never-recorded",
      outcomes: 0,
      players: [],
    });
    expect(await stored("elo", "ada")).toEqual(after);
  });

  test("a later recalculation keeps the void", async () => {
    await play("elo", { ada: 1, bob: 2 }, { resultId: "r-1" });
    await play("elo", { ada: 1, bob: 2 }, { resultId: "r-2" });
    await voidResult(db(), GAMES, "r-2", later);
    const voided = await stored("elo", "ada");

    const { adjustment } = await adjustRating(db(), GAMES, act({ act: "recalculate", userId: "ada" }), later);
    expect(adjustment.after.skill).toBe(voided.skill);
    expect(adjustment.after.games).toBe(1);
  });

  test("is what the composed capability hands a void cascade, bound to its configured games", async () => {
    await play("elo", { ada: 1, bob: 2 }, { resultId: "r-1" });
    const peer = rating(CONFIG).ratingPeer;
    const report = await peer.voidResult(env.DB, "r-1", later);
    expect(report.outcomes).toBe(1);
    expect(report.players.map((player) => player.after.games)).toEqual([0, 0]);
    expect((await stored("elo", "ada")).skill).toBe(1500);
  });
});
