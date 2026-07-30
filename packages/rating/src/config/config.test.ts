// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm/algorithm";
import { registerRatingAlgorithm } from "../algorithm/registry";
import { configuredPools, RatingConfig, resolveGame, validateRatingGames } from "./config";

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

// Stub algorithms so config tests never depend on the built-ins (or their math). One 1v1-only, one any-
// count with teams — enough to exercise every assembly-rejection branch.
const Solo: RatingAlgorithm<{ n: number }, { base: number }> = {
  id: "stub-1v1",
  params: z.object({ base: z.number().default(1000).describe("base") }).describe("stub params"),
  state: z.object({ n: z.number().describe("n") }).describe("stub state"),
  minPlayers: 2,
  maxPlayers: 2,
  supportsTeams: false,
  initial: (p) => ({ n: p.base }),
  update: (_p, entries) => Object.fromEntries(entries.map((e) => [e.playerId, e.state])),
  skill: (_p, s) => s.n,
};

const Many: RatingAlgorithm<{ n: number }, Record<string, never>> = {
  id: "stub-many",
  params: z.object({}).describe("no params"),
  state: z.object({ n: z.number().describe("n") }).describe("stub state"),
  minPlayers: 2,
  maxPlayers: Number.POSITIVE_INFINITY,
  supportsTeams: true,
  initial: () => ({ n: 0 }),
  update: (_p, entries) => Object.fromEntries(entries.map((e) => [e.playerId, e.state])),
  skill: (_p, s) => s.n,
};

beforeAll(() => {
  registerRatingAlgorithm(Solo as RatingAlgorithm);
  registerRatingAlgorithm(Many as RatingAlgorithm);
});

describe("RatingConfig parse", () => {
  test("rejects duplicate game keys", () => {
    expect(() =>
      RatingConfig.parse({
        games: [
          { key: "duel", algorithm: "stub-1v1" },
          { key: "duel", algorithm: "stub-many" },
        ],
      }),
    ).toThrow(/Duplicate game key/);
  });

  test("requires at least one game", () => {
    expect(() => RatingConfig.parse({ games: [] })).toThrow(/at least one/);
  });

  test("defaults serverAuthoritative and recordScope", () => {
    const config = RatingConfig.parse({ games: [{ key: "duel", algorithm: "stub-1v1" }] });
    expect(config.serverAuthoritative).toBe(true);
    expect(config.recordScope).toBe("rating:record");
  });
});

describe("validateRatingGames", () => {
  test("resolves a valid game and defaults the pool to the game key", () => {
    const config = RatingConfig.parse({ games: [{ key: "duel", algorithm: "stub-1v1" }] });
    const [first] = validateRatingGames(config);
    const resolved = need(first);
    expect(resolved.game.pool).toBe("duel");
    expect(resolved.algorithm.id).toBe("stub-1v1");
    expect(resolved.params).toEqual({ base: 1000 });
  });

  test("honors an explicit shared pool", () => {
    const config = RatingConfig.parse({
      games: [
        { key: "a", algorithm: "stub-many", pool: "global" },
        { key: "b", algorithm: "stub-many", pool: "global" },
      ],
    });
    const games = validateRatingGames(config);
    expect(configuredPools(games)).toEqual(["global"]);
  });

  test("rejects an unknown algorithm", () => {
    const config = RatingConfig.parse({ games: [{ key: "duel", algorithm: "nope" }] });
    expect(() => validateRatingGames(config)).toThrow(/rating\/unknown_algorithm|unknown algorithm/i);
  });

  test("rejects an N-player roster on a 1v1-only algorithm", () => {
    const config = RatingConfig.parse({ games: [{ key: "ffa", algorithm: "stub-1v1", players: 4 }] });
    expect(() => validateRatingGames(config)).toThrow(/supports 2\b/);
  });

  test("accepts any count on an any-count algorithm", () => {
    const config = RatingConfig.parse({ games: [{ key: "ffa", algorithm: "stub-many", players: 8 }] });
    expect(() => validateRatingGames(config)).not.toThrow();
  });

  test("rejects a team format on a non-team algorithm", () => {
    const config = RatingConfig.parse({ games: [{ key: "duel", algorithm: "stub-1v1", teams: true }] });
    expect(() => validateRatingGames(config)).toThrow(/cannot rate teams/i);
  });

  test("rejects invalid algoParams", () => {
    const config = RatingConfig.parse({
      games: [{ key: "duel", algorithm: "stub-1v1", algoParams: { base: "high" } }],
    });
    expect(() => validateRatingGames(config)).toThrow(/invalid algoParams|rating\/invalid_params/i);
  });

  test("resolveGame finds a resolved game by key", () => {
    const config = RatingConfig.parse({ games: [{ key: "duel", algorithm: "stub-1v1" }] });
    const games = validateRatingGames(config);
    expect(resolveGame(games, "duel")?.game.key).toBe("duel");
    expect(resolveGame(games, "missing")).toBeUndefined();
  });
});
