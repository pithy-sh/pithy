// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ResolvedRatingGame } from "../config/config";
import type { RatingAdjustment } from "../data/adjustment";
import type { PlayerOutcome } from "../data/log";
import type { RatingRecord } from "../data/rating";
import type { RatingAdjustmentResponse, RatingAdminOutcome, RatingAdminRating } from "./responses";

/**
 * The projections behind the management responses. Each returns its schema's type from `responses.ts`, so
 * a field the schema lacks is a red build, and `responses.test.ts` parses each projection and compares it
 * with what went in, so a field the schema has and the projection forgets fails too.
 */

/** A stored rating, whole. */
export function ratingView(record: RatingRecord): RatingAdminRating {
  return {
    pool: record.pool,
    userId: record.userId,
    algorithm: record.algorithm,
    state: record.state,
    skill: record.skill,
    xp: record.xp,
    games: record.games,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * One logged outcome from where `userId` stood. `skillBefore` is derived through the pool's algorithm from
 * the state the log kept, so it reads in the same units as the rating beside it.
 */
export function outcomeView(row: PlayerOutcome, pool: ResolvedRatingGame): RatingAdminOutcome {
  const { entry, outcome } = row;
  const { algorithm, params } = pool;
  return {
    game: outcome.game,
    resultId: outcome.resultId,
    rank: outcome.ranks[entry.userId] ?? 0,
    ranks: outcome.ranks,
    teams: outcome.teams,
    sharedRoom: outcome.sharedRoom,
    voided: outcome.voidedAt !== null,
    voidedAt: outcome.voidedAt?.toISOString() ?? null,
    skillBefore: algorithm.skill(params, algorithm.state.parse(entry.stateBefore)),
    xpBefore: entry.xpBefore,
    gamesBefore: entry.gamesBefore,
    xpGained: entry.xpGained,
    at: outcome.at.toISOString(),
  };
}

/** What one act did, and whether this request was the one that did it. */
export function adjustmentView(adjustment: RatingAdjustment, replayed: boolean): RatingAdjustmentResponse {
  return {
    pool: adjustment.pool,
    userId: adjustment.userId,
    act: adjustment.act,
    reason: adjustment.reason,
    before: adjustment.before,
    after: adjustment.after,
    at: adjustment.at.toISOString(),
    replayed,
  };
}
