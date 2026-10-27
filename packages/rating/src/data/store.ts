// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { type Compilable, runBatch } from "./batch";
import { RatingOutcome, RatingOutcomePlayer } from "./outcome";
import { RatingRecord } from "./rating";
import {
  RATING_OUTCOME_PLAYERS_TABLE,
  RATING_OUTCOMES_TABLE,
  RATING_RATINGS_TABLE,
  type RatingDatabase,
} from "./tables";

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
  /**
   * Apply one outcome: append it to the outcome log and write every participant's new standing, **as one
   * transaction**. A rating that moved with no outcome behind it could never be recalculated, and an
   * outcome logged with no rating behind it would be replayed into one nobody saw — so both land or
   * neither does.
   */
  apply(outcome: AppliedOutcome, records: readonly RatingRecord[]): Promise<void>;
}

/** One participant as the outcome log keeps them: the standing they went in with, and what they gained. */
export interface AppliedParticipant {
  /** The participant's user id. */
  userId: string;
  /** The algorithm state they went into the game with — the starting state for a newcomer. */
  stateBefore: unknown;
  /** Their experience total in the pool before the game. */
  xpBefore: number;
  /** How many rated games they had completed in the pool before it. */
  gamesBefore: number;
  /** The experience the game awarded them. */
  xpGained: number;
}

/** An outcome as {@link RatingStore.apply} logs it. */
export interface AppliedOutcome {
  /** The pool it is applied to. */
  pool: string;
  /** The configured game it was recorded against. */
  game: string;
  /** The result it came from, or null when the recorder named none. */
  resultId: string | null;
  /** Each player's finishing place. */
  ranks: Record<string, number>;
  /** The team grouping, or null. */
  teams: Record<string, string> | null;
  /** Whether it was a shared-room game. */
  sharedRoom: boolean;
  /** When it was applied. */
  at: Date;
  /** Every participant, in roster order. */
  players: readonly AppliedParticipant[];
}

/** The upsert of one standing, as a statement that can join a batch. */
export function upsertQuery(db: RatingDatabase, record: RatingRecord) {
  const row = RatingRecord.encode(record) as Record<string, unknown>;
  delete row.id;
  return db
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
    );
}

/**
 * The statements that append one outcome to the log. Each participant row names its outcome by the
 * highest outcome id, read inside the same transaction — the row the batch inserted a statement earlier,
 * since D1 runs a batch alone and autoincrement only rises.
 */
export function appendOutcomeQueries(db: RatingDatabase, outcome: AppliedOutcome): Compilable[] {
  const row = RatingOutcome.encode({
    id: 0,
    pool: outcome.pool,
    game: outcome.game,
    resultId: outcome.resultId,
    ranks: outcome.ranks,
    teams: outcome.teams,
    sharedRoom: outcome.sharedRoom,
    voidedAt: null,
    at: outcome.at,
  }) as Record<string, unknown>;
  delete row.id;
  const queries: Compilable[] = [db.insertInto(RATING_OUTCOMES_TABLE).values(row as never)];
  for (const player of outcome.players) {
    const encoded = RatingOutcomePlayer.encode({
      id: 0,
      outcomeId: 0,
      pool: outcome.pool,
      userId: player.userId,
      stateBefore: player.stateBefore,
      xpBefore: player.xpBefore,
      gamesBefore: player.gamesBefore,
      xpGained: player.xpGained,
    }) as Record<string, unknown>;
    delete encoded.id;
    queries.push(
      db.insertInto(RATING_OUTCOME_PLAYERS_TABLE).values(
        (eb) =>
          ({
            ...encoded,
            outcomeId: eb.selectFrom(RATING_OUTCOMES_TABLE).select((inner) => inner.fn.max("id").as("id")),
          }) as never,
      ),
    );
  }
  return queries;
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
      // A roster is as big as the game says it is: `players` has a minimum of two and no maximum, and
      // the docs promise any count. So the roster is chunked against D1's cap rather than assumed to
      // fit — one parameter per player, plus the pool. Unchunked, a 120-player game failed every
      // `recordResult`, and no two-player test could have said so (#250).
      const records: RatingRecord[] = [];
      for (const chunk of chunkByBoundParameters(userIds, 1)) {
        const rows = await db
          .selectFrom(RATING_RATINGS_TABLE)
          .selectAll()
          .where("pool", "=", pool)
          .where("userId", "in", chunk)
          .execute();
        for (const row of rows) records.push(RatingRecord.parse(row));
      }
      return records;
    },

    async upsert(record) {
      await upsertQuery(db, record).execute();
    },

    async apply(outcome, records) {
      await runBatch(db, [...appendOutcomeQueries(db, outcome), ...records.map((record) => upsertQuery(db, record))]);
    },
  };
}
