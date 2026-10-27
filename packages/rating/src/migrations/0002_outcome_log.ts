// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Creates the outcome log and the control-plane act record (#818). `0001` is released history and is never
 * edited, so the log is a migration of its own.
 *
 * - `pithy_rating_outcomes` — one row per applied outcome. `(pool, id)` serves a pool's history in order;
 *   `resultId` is what a void addresses outcomes by.
 * - `pithy_rating_outcome_players` — one row per participant. Unique on `(outcomeId, userId)`, since a player
 *   is in a game once. `(pool, userId, id)` is a player's history as one range scan, in the order it
 *   happened, which is the order a replay walks it.
 * - `pithy_rating_adjustments` — one row per control-plane act. Unique on `idempotencyKey`, so the database
 *   decides which of two concurrent requests with one key wins, never a read that could race.
 *
 * Ratings already in `pithy_rating_ratings` get no rows here: their history was never kept, and inventing
 * one would make a recalculation look exact when it is not.
 */
export const rating_0002_outcome_log: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyRatingOutcomes")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("pool", "text", (c) => c.notNull())
      .addColumn("game", "text", (c) => c.notNull())
      .addColumn("resultId", "text")
      .addColumn("ranks", "text", (c) => c.notNull())
      .addColumn("teams", "text")
      .addColumn("sharedRoom", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("voidedAt", "integer")
      .addColumn("at", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyRatingOutcomesPoolIdx")
      .on("pithyRatingOutcomes")
      .columns(["pool", "id"])
      .execute();
    await db.schema
      .createIndex("pithyRatingOutcomesResultIdx")
      .on("pithyRatingOutcomes")
      .columns(["resultId"])
      .execute();

    await db.schema
      .createTable("pithyRatingOutcomePlayers")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("outcomeId", "integer", (c) => c.notNull())
      .addColumn("pool", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("stateBefore", "text", (c) => c.notNull())
      .addColumn("xpBefore", "real", (c) => c.notNull().defaultTo(0))
      .addColumn("gamesBefore", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("xpGained", "real", (c) => c.notNull().defaultTo(0))
      .execute();
    await db.schema
      .createIndex("pithyRatingOutcomePlayersOutcomeIdx")
      .on("pithyRatingOutcomePlayers")
      .columns(["outcomeId", "userId"])
      .unique()
      .execute();
    await db.schema
      .createIndex("pithyRatingOutcomePlayersPlayerIdx")
      .on("pithyRatingOutcomePlayers")
      .columns(["pool", "userId", "id"])
      .execute();

    await db.schema
      .createTable("pithyRatingAdjustments")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("idempotencyKey", "text", (c) => c.notNull())
      .addColumn("act", "text", (c) => c.notNull())
      .addColumn("pool", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("before", "text")
      .addColumn("after", "text", (c) => c.notNull())
      .addColumn("floorEntry", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("at", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyRatingAdjustmentsKeyIdx")
      .on("pithyRatingAdjustments")
      .columns(["idempotencyKey"])
      .unique()
      .execute();
    await db.schema
      .createIndex("pithyRatingAdjustmentsPlayerIdx")
      .on("pithyRatingAdjustments")
      .columns(["pool", "userId", "id"])
      .execute();
  },

  down: async (db: Kysely<unknown>) => {
    await db.schema.dropIndex("pithyRatingAdjustmentsPlayerIdx").execute();
    await db.schema.dropIndex("pithyRatingAdjustmentsKeyIdx").execute();
    await db.schema.dropTable("pithyRatingAdjustments").execute();
    await db.schema.dropIndex("pithyRatingOutcomePlayersPlayerIdx").execute();
    await db.schema.dropIndex("pithyRatingOutcomePlayersOutcomeIdx").execute();
    await db.schema.dropTable("pithyRatingOutcomePlayers").execute();
    await db.schema.dropIndex("pithyRatingOutcomesResultIdx").execute();
    await db.schema.dropIndex("pithyRatingOutcomesPoolIdx").execute();
    await db.schema.dropTable("pithyRatingOutcomes").execute();
  },
};
