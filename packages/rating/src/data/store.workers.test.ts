// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm/algorithm";
import type { ResolvedRatingGame } from "../config/config";
import { rating_0001_rating } from "../migrations/0001_rating";
import { recordOutcome } from "../record/record";
import type { RatingRecord } from "./rating";
import { ratingStore } from "./store";
import { ratingDatabase } from "./tables";

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_rating_ratings");
  await rating_0001_rating.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

function record(userId: string, skill: number, xp: number): RatingRecord {
  return {
    id: 0,
    pool: "demo",
    userId,
    algorithm: "elo",
    state: { rating: skill },
    skill,
    xp,
    games: 1,
    updatedAt: new Date("2026-07-25T00:00:00Z"),
  };
}

describe("ratingStore", () => {
  test("round-trips a record through D1 (decode equals what was encoded)", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1520, 40));
    const got = await store.get("demo", "ada");
    expect(got?.skill).toBe(1520);
    expect(got?.xp).toBe(40);
    expect(got?.state).toEqual({ rating: 1520 });
    expect(got?.updatedAt).toBeInstanceOf(Date);
  });

  test("upsert updates in place on (pool, userId) rather than duplicating", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1500, 10));
    await store.upsert(record("ada", 1540, 30));
    const rows = await store.getMany("demo", ["ada"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe(1540);
    expect(rows[0]?.xp).toBe(30);
  });

  test("getMany returns only existing players in the pool", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    await store.upsert(record("ada", 1500, 10));
    await store.upsert(record("alan", 1450, 5));
    const rows = await store.getMany("demo", ["ada", "alan", "ghost"]);
    expect(rows.map((r) => r.userId).sort()).toEqual(["ada", "alan"]);
  });

  test("get returns undefined for an unrated player", async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    expect(await store.get("demo", "nobody")).toBeUndefined();
  });
});

/**
 * A roster is as big as the game says it is.
 *
 * `players` is `.int().min(2)` with no maximum and the docs say any count, so `getMany` binds one
 * parameter per player plus the pool. Past 99 players the claim was false: every `recordResult` for that
 * game failed, and nothing in a suite of two-player duels could ever have said so (#250).
 */
const Stub: RatingAlgorithm<{ skill: number }, Record<string, never>> = {
  id: "stub",
  params: z.object({}).describe("No parameters."),
  state: z.object({ skill: z.number().describe("The player's skill.") }).describe("The stub algorithm's state."),
  minPlayers: 2,
  maxPlayers: Number.POSITIVE_INFINITY,
  supportsTeams: false,
  initial: () => ({ skill: 0 }),
  update: (_params, entries, outcome) =>
    Object.fromEntries(
      entries.map((entry) => [entry.playerId, { skill: 1000 - (outcome.ranks[entry.playerId] ?? 0) }]),
    ),
  skill: (_params, state) => state.skill,
};

function bigGame(players: number): ResolvedRatingGame {
  return {
    algorithm: Stub as RatingAlgorithm,
    params: {},
    game: {
      key: "battle-royale",
      algorithm: "stub",
      players,
      teams: false,
      hideSkill: false,
      pool: "demo",
      sharedRoomCounts: false,
    } as ResolvedRatingGame["game"],
  };
}

const roster = (players: number) =>
  Object.fromEntries(Array.from({ length: players }, (_, index) => [`p${index}`, index + 1]));

describe("ratingStore and D1's bound-parameter ceiling", () => {
  test("a 120-player game records its result", { timeout: 30_000 }, async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    const players = 120;

    const recorded = await recordOutcome(store, bigGame(players), { ranks: roster(players), at: new Date() });

    expect(recorded).toHaveLength(players);
    expect((await store.getMany("demo", Object.keys(roster(players)))).length).toBe(players);
  });

  test("no statement binds more than D1 accepts, at any roster size", async () => {
    // Widths spanning the budget boundary: under it, exactly on it, one past it, and well past.
    for (const players of [2, 98, 99, 100, 250]) {
      const ids = Array.from({ length: players }, (_, index) => `p${index}`);
      const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
        await ratingStore(ratingDatabase(d1)).getMany("demo", ids);
      });

      const worst = Math.max(...counts, 0);
      expect(worst, `${players} players: nothing was bound`).toBeGreaterThan(0);
      expect(
        worst,
        `${players} players: one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
      if (error) throw error;
    }
  });

  test("chunking loses nobody — every existing player in a big roster comes back once", {
    timeout: 30_000,
  }, async () => {
    const store = ratingStore(ratingDatabase(env.DB));
    const ids = Array.from({ length: 250 }, (_, index) => `p${index}`);
    for (const id of ids) await store.upsert(record(id, 1500, 0));

    const rows = await store.getMany("demo", [...ids, "ghost"]);

    expect(rows).toHaveLength(250);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(250);
  });
});
