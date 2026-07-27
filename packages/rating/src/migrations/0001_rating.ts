import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Creates `pithy_rating_ratings` — one row per (pool, player) holding the skill rating state, the
 * denormalized conservative `skill` number, and the monotonic `xp` total. All identifiers are camelCase;
 * the migration runner's `CamelCasePlugin` snake-cases them to `pithy_rating_*` columns.
 *
 * The unique `(pool, userId)` index is the upsert conflict target. The `(pool, skill)` index serves
 * matchmaking's skill-bucketed reads and any leaderboard-style rank scan over the pool.
 */
export const rating_0001_rating: Migration = {
  up: async (db: Kysely<unknown>) => {
    await db.schema
      .createTable("pithyRatingRatings")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("pool", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("algorithm", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("skill", "real", (c) => c.notNull())
      .addColumn("xp", "real", (c) => c.notNull().defaultTo(0))
      .addColumn("games", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("pithyRatingRatingsPlayerIdx")
      .on("pithyRatingRatings")
      .columns(["pool", "userId"])
      .unique()
      .execute();

    await db.schema
      .createIndex("pithyRatingRatingsSkillIdx")
      .on("pithyRatingRatings")
      .columns(["pool", "skill"])
      .execute();
  },

  down: async (db: Kysely<unknown>) => {
    await db.schema.dropIndex("pithyRatingRatingsSkillIdx").execute();
    await db.schema.dropIndex("pithyRatingRatingsPlayerIdx").execute();
    await db.schema.dropTable("pithyRatingRatings").execute();
  },
};
