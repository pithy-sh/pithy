// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import "../algorithm/builtins";
import { RatingConfig, resolvePool, validateRatingGames } from "../config/config";
import type { RatingAdjustment } from "../data/adjustment";
import type { PlayerOutcome } from "../data/log";
import type { RatingRecord } from "../data/rating";
import type { RatingVoidResult } from "../history/void";
import {
  RatingAdjustmentResponse,
  RatingAdminOutcome,
  RatingAdminRating,
  RatingSnapshotView,
  RatingVoidReport,
} from "./responses";
import { adjustmentView, outcomeView, ratingView } from "./view";

/**
 * The management response schemas against what the projections produce. **Equality, not `.parse()`
 * alone**: a Zod object strips unknown keys, so a bare parse passes a projection that grew a field the
 * schema never heard of. Comparing the parsed value with the input fails in both directions.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const AT = new Date("2026-10-20T12:00:00.000Z");
const GAMES = validateRatingGames(RatingConfig.parse({ games: [{ key: "duel", algorithm: "elo" }] }));
const DUEL = resolvePool(GAMES, "duel");

const RECORD: RatingRecord = {
  id: 4,
  pool: "duel",
  userId: "ada",
  algorithm: "elo",
  state: { rating: 1516 },
  skill: 1516,
  xp: 20,
  games: 1,
  updatedAt: AT,
};

const SNAPSHOT = { algorithm: "elo", state: { rating: 1516 }, skill: 1516, xp: 20, games: 1 };

const ROW: PlayerOutcome = {
  entry: {
    id: 9,
    outcomeId: 3,
    pool: "duel",
    userId: "ada",
    stateBefore: { rating: 1500 },
    xpBefore: 0,
    gamesBefore: 0,
    xpGained: 20,
  },
  outcome: {
    id: 3,
    pool: "duel",
    game: "duel",
    resultId: "match-1",
    ranks: { ada: 1, bob: 2 },
    teams: null,
    sharedRoom: false,
    voidedAt: null,
    at: AT,
  },
};

describe("rating's management response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    if (!DUEL) throw new Error("no pool");
    accepts(RatingAdminRating, ratingView(RECORD));
    accepts(RatingAdminOutcome, outcomeView(ROW, DUEL));
    accepts(
      RatingAdminOutcome,
      outcomeView({ ...ROW, outcome: { ...ROW.outcome, voidedAt: AT, resultId: null } }, DUEL),
    );
    accepts(RatingSnapshotView, SNAPSHOT);
  });

  test("an outcome reads from where the player stood", () => {
    if (!DUEL) throw new Error("no pool");
    expect(outcomeView(ROW, DUEL)).toMatchObject({ rank: 1, skillBefore: 1500, voided: false, voidedAt: null });
    expect(outcomeView({ ...ROW, outcome: { ...ROW.outcome, voidedAt: AT } }, DUEL)).toMatchObject({
      voided: true,
      voidedAt: AT.toISOString(),
    });
  });

  test("an act's view carries before, after and whether it was a replay", () => {
    const adjustment: RatingAdjustment = {
      id: 1,
      idempotencyKey: "k-1",
      act: "reset",
      pool: "duel",
      userId: "ada",
      reason: "Dispute.",
      before: SNAPSHOT,
      after: { ...SNAPSHOT, state: { rating: 1500 }, skill: 1500 },
      floorEntry: 9,
      at: AT,
    };
    accepts(RatingAdjustmentResponse, adjustmentView(adjustment, false));
    accepts(RatingAdjustmentResponse, adjustmentView({ ...adjustment, before: null }, true));
    // Neither the surrogate key nor the replay floor is part of the contract.
    expect(Object.keys(adjustmentView(adjustment, false))).not.toContain("id");
    expect(Object.keys(adjustmentView(adjustment, false))).not.toContain("floorEntry");
  });

  test("the void consumer's result is exactly the report it declares", () => {
    const result: RatingVoidResult = {
      resultId: "match-1",
      outcomes: 1,
      players: [{ pool: "duel", userId: "ada", before: SNAPSHOT, after: { ...SNAPSHOT, skill: 1500 } }],
    };
    accepts(RatingVoidReport, result);
    accepts(RatingVoidReport, { resultId: "match-2", outcomes: 0, players: [] });
  });
});
