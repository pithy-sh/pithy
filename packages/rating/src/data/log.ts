// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { RatingAdjustment } from "./adjustment";
import { RatingOutcome, RatingOutcomePlayer } from "./outcome";
import {
  RATING_ADJUSTMENTS_TABLE,
  RATING_OUTCOME_PLAYERS_TABLE,
  RATING_OUTCOMES_TABLE,
  type RatingDatabase,
} from "./tables";

/**
 * The reads over the outcome log and the act record — what a replay, a void and the management reads
 * need, and nothing that writes a rating. The appends happen in `store.ts`, inside the transaction that
 * moves the rating, so a log row never exists without the rating it describes.
 *
 * Every read decodes through the table's schema, so a row is validated on the way out of D1 exactly as it
 * was on the way in. Every `IN` list is chunked against D1's bound-parameter cap, because a void can touch
 * an outcome with any roster size the game allows.
 */

/** One player's place in one outcome, with the outcome itself. */
export interface PlayerOutcome {
  /** The player's row: the standing they went in with, and what the game awarded them. */
  entry: RatingOutcomePlayer;
  /** The outcome the row belongs to. */
  outcome: RatingOutcome;
}

/** One page of a player's outcomes, newest first. */
export interface PlayerOutcomePage {
  /** The outcomes on this page. */
  items: PlayerOutcome[];
  /** Where the next page resumes, or null at the end. Opaque. */
  nextCursor: string | null;
}

export interface OutcomeLog {
  /** Every row a player has in a pool, oldest first — the order a replay walks. */
  playerEntries(pool: string, userId: string): Promise<RatingOutcomePlayer[]>;
  /** Every participant row of the given outcomes. */
  participants(outcomeIds: readonly number[]): Promise<RatingOutcomePlayer[]>;
  /** The given outcomes, by id. Missing ids are absent. */
  outcomes(outcomeIds: readonly number[]): Promise<RatingOutcome[]>;
  /** Every outcome recorded with a result id, voided or not, oldest first. */
  byResult(resultId: string): Promise<RatingOutcome[]>;
  /** A page of one player's outcomes in a pool, newest first. */
  playerPage(pool: string, userId: string, query: { cursor?: string; limit?: number }): Promise<PlayerOutcomePage>;
  /** The latest reset of a player in a pool — the floor a replay starts its skill from — or undefined. */
  latestReset(pool: string, userId: string): Promise<RatingAdjustment | undefined>;
  /** The act an idempotency key was spent on, or undefined while it is unspent. */
  adjustment(idempotencyKey: string): Promise<RatingAdjustment | undefined>;
}

export function outcomeLog(db: RatingDatabase): OutcomeLog {
  const participants = async (outcomeIds: readonly number[]) => {
    const rows: RatingOutcomePlayer[] = [];
    for (const chunk of chunkByBoundParameters(outcomeIds, 0)) {
      const found = await db
        .selectFrom(RATING_OUTCOME_PLAYERS_TABLE)
        .selectAll()
        .where("outcomeId", "in", chunk)
        .orderBy("id", "asc")
        .execute();
      for (const row of found) rows.push(RatingOutcomePlayer.parse(row));
    }
    return rows;
  };

  const outcomes = async (outcomeIds: readonly number[]) => {
    const rows: RatingOutcome[] = [];
    for (const chunk of chunkByBoundParameters([...new Set(outcomeIds)], 0)) {
      const found = await db
        .selectFrom(RATING_OUTCOMES_TABLE)
        .selectAll()
        .where("id", "in", chunk)
        .orderBy("id", "asc")
        .execute();
      for (const row of found) rows.push(RatingOutcome.parse(row));
    }
    return rows;
  };

  return {
    async playerEntries(pool, userId) {
      const rows = await db
        .selectFrom(RATING_OUTCOME_PLAYERS_TABLE)
        .selectAll()
        .where("pool", "=", pool)
        .where("userId", "=", userId)
        .orderBy("id", "asc")
        .execute();
      return rows.map((row) => RatingOutcomePlayer.parse(row));
    },

    participants,
    outcomes,

    async byResult(resultId) {
      const rows = await db
        .selectFrom(RATING_OUTCOMES_TABLE)
        .selectAll()
        .where("resultId", "=", resultId)
        .orderBy("id", "asc")
        .execute();
      return rows.map((row) => RatingOutcome.parse(row));
    },

    async playerPage(pool, userId, query) {
      const limit = pageLimit(query.limit);
      const decoded = decodeCursor(query.cursor);
      const before = typeof decoded?.id === "number" ? decoded.id : undefined;
      let selection = db
        .selectFrom(RATING_OUTCOME_PLAYERS_TABLE)
        .selectAll()
        .where("pool", "=", pool)
        .where("userId", "=", userId)
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (before !== undefined) selection = selection.where("id", "<", before);
      const entries = (await selection.execute()).map((row) => RatingOutcomePlayer.parse(row));
      const byId = new Map((await outcomes(entries.map((entry) => entry.outcomeId))).map((row) => [row.id, row]));
      const joined: PlayerOutcome[] = [];
      for (const entry of entries) {
        const outcome = byId.get(entry.outcomeId);
        if (outcome) joined.push({ entry, outcome });
      }
      return toPage(joined, limit, (row) => ({ sort: row.entry.id, id: row.entry.id }));
    },

    async latestReset(pool, userId) {
      const row = await db
        .selectFrom(RATING_ADJUSTMENTS_TABLE)
        .selectAll()
        .where("pool", "=", pool)
        .where("userId", "=", userId)
        .where("act", "=", "reset")
        .orderBy("id", "desc")
        .executeTakeFirst();
      return row ? RatingAdjustment.parse(row) : undefined;
    },

    async adjustment(idempotencyKey) {
      const row = await db
        .selectFrom(RATING_ADJUSTMENTS_TABLE)
        .selectAll()
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst();
      return row ? RatingAdjustment.parse(row) : undefined;
    },
  };
}
