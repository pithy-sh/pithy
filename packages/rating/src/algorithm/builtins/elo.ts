// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { RatingUnsupportedPlayerCountError } from "../../error/errors";
import type { RatedOutcome, RatingAlgorithm, RatingEntry } from "../algorithm";

/**
 * Elo — the classic 1v1 rating. One number per player, no modeled uncertainty: a game nudges the pair
 * toward or away from each other by `k · (actual − expected)`, where `expected` is the logistic of the
 * rating gap over a 400-point scale. Deterministic and symmetric — the winner's gain equals the loser's
 * loss. 1v1 only; N-player and team formats use `trueskill`.
 */

/** One Elo player's persisted state: a single rating number, round-tripped through D1 between games. */
export const EloState = z
  .object({
    rating: z
      .number()
      .describe("The player's current Elo rating — higher is stronger. Newcomers start at `initialRating`."),
  })
  .describe("The per-player Elo state persisted between games: just the rating number.");
export type EloState = z.output<typeof EloState>;

/** Elo's declarative tuning: the K-factor (volatility) and the newcomer's starting rating. */
export const EloParams = z
  .object({
    k: z
      .number()
      .positive()
      .default(32)
      .describe(
        "The K-factor — the maximum rating swing from a single game. Higher reacts faster; lower is more stable. Default 32.",
      ),
    initialRating: z
      .number()
      .default(1500)
      .describe("The rating a brand-new player enters the pool with. The conventional Elo midpoint is 1500."),
  })
  .describe(
    "Elo's tuning block: K-factor and starting rating. Every field defaults, so `EloParams.parse({})` yields the standard tuning.",
  );
export type EloParams = z.output<typeof EloParams>;

/** The 1v1 score of `a` against `b` from their finishing places: lower place is better. Win 1, draw 0.5, loss 0. */
function scoreFromRanks(aRank: number, bRank: number): number {
  if (aRank < bRank) return 1;
  if (aRank > bRank) return 0;
  return 0.5;
}

/** The classic Elo algorithm — a single instance registered by `id`, not a factory. */
export const elo: RatingAlgorithm<EloState, EloParams> = {
  id: "elo",
  params: EloParams,
  state: EloState,
  minPlayers: 2,
  maxPlayers: 2,
  supportsTeams: false,

  initial(params: EloParams): EloState {
    return { rating: params.initialRating };
  },

  update(
    params: EloParams,
    entries: readonly RatingEntry<EloState>[],
    outcome: RatedOutcome,
  ): Record<string, EloState> {
    if (entries.length !== 2) {
      throw new RatingUnsupportedPlayerCountError({
        detail: `elo.update expected exactly 2 entries, got ${entries.length}.`,
      });
    }
    const a = entries[0];
    const b = entries[1];
    if (a === undefined || b === undefined) {
      throw new RatingUnsupportedPlayerCountError({
        detail: `elo.update expected exactly 2 entries, got ${entries.length}.`,
      });
    }
    const ratingA = a.state.rating;
    const ratingB = b.state.rating;

    const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
    const expectedB = 1 - expectedA;

    const rankA = outcome.ranks[a.playerId];
    const rankB = outcome.ranks[b.playerId];
    if (rankA === undefined || rankB === undefined) {
      throw new RatingUnsupportedPlayerCountError({
        detail: "elo.update requires a rank for each of its two players.",
      });
    }
    const scoreA = scoreFromRanks(rankA, rankB);
    const scoreB = scoreFromRanks(rankB, rankA);

    return {
      [a.playerId]: { rating: ratingA + params.k * (scoreA - expectedA) },
      [b.playerId]: { rating: ratingB + params.k * (scoreB - expectedB) },
    };
  },

  skill(_params: EloParams, state: EloState): number {
    return state.rating;
  },
};
