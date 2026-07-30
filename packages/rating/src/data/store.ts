// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RatingRecord } from "./rating";
import { RATING_RATINGS_TABLE, type RatingDatabase } from "./tables";

/**
 * The rating store — the only place that reads and writes `pithy_rating_ratings`. Reads decode with
 * `RatingRecord.parse` (SQLite row → app shape); writes encode with `RatingRecord.encode` then upsert on
 * the unique `(pool, userId)` pair, so recording the same roster twice updates in place rather than
 * duplicating. The round-trip rule (CLAUDE.md §Data layer) is honored on every path.
 */
export interface RatingStore {
  /** A player's standing in a pool, or undefined if they have no rated games there yet. */
  get(pool: string, userId: string): Promise<RatingRecord | undefined>;
  /** Every existing standing for a set of players in a pool (a game's roster). Missing players are absent. */
  getMany(pool: string, userIds: readonly string[]): Promise<RatingRecord[]>;
  /** Insert or update a player's standing, keyed on `(pool, userId)`. */
  upsert(record: RatingRecord): Promise<void>;
}

export function ratingStore(db: RatingDatabase): RatingStore {
  return {
    async get(pool, userId) {
      const row = await db
        .selectFrom(RATING_RATINGS_TABLE)
        .selectAll()
        .where("pool", "=", pool)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return row ? RatingRecord.parse(row) : undefined;
    },

    async getMany(pool, userIds) {
      if (userIds.length === 0) return [];
      const rows = await db
        .selectFrom(RATING_RATINGS_TABLE)
        .selectAll()
        .where("pool", "=", pool)
        .where("userId", "in", [...userIds])
        .execute();
      return rows.map((row) => RatingRecord.parse(row));
    },

    async upsert(record) {
      const row = RatingRecord.encode(record) as Record<string, unknown>;
      delete row.id;
      await db
        .insertInto(RATING_RATINGS_TABLE)
        .values(row as never)
        .onConflict((oc) =>
          oc.columns(["pool", "userId"]).doUpdateSet({
            algorithm: record.algorithm,
            state: RatingRecord.shape.state.encode(record.state),
            skill: record.skill,
            xp: record.xp,
            games: record.games,
            updatedAt: RatingRecord.shape.updatedAt.encode(record.updatedAt),
          }),
        )
        .execute();
    },
  };
}
