import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The multiplayer results table — the durable record a terminal session writes.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * There is no session/membership/commit table on purpose: live session state lives in the Durable
 * Object's own storage, which is where authority and hidden state belong. D1 holds only what must outlive
 * the object and be queryable beside the adopter's tables — the result.
 */
export const multiplayer_0001_results: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyMultiplayerResults")
      // Plain INTEGER PRIMARY KEY (a rowid alias), not autoincrement — the id is internal and never
      // exposed, so the never-reuse-a-deleted-id guarantee autoincrement adds is not worth its cost.
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("sessionId", "text", (c) => c.notNull().unique())
      .addColumn("gameKey", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("players", "text", (c) => c.notNull())
      .addColumn("scores", "text")
      .addColumn("winnerUserId", "text")
      .addColumn("draw", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("resolvedAt", "integer", (c) => c.notNull())
      .execute();

    // Results are browsed by game ("recent battles") and by winner ("this player's wins"), so both get an
    // index. The unique constraint on sessionId already covers by-session lookups.
    await db.schema
      .createIndex("pithyMultiplayerResultsGameIdx")
      .on("pithyMultiplayerResults")
      .columns(["gameKey", "resolvedAt"])
      .execute();
    await db.schema
      .createIndex("pithyMultiplayerResultsWinnerIdx")
      .on("pithyMultiplayerResults")
      .columns(["winnerUserId"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMultiplayerResultsWinnerIdx").execute();
    await db.schema.dropIndex("pithyMultiplayerResultsGameIdx").execute();
    await db.schema.dropTable("pithyMultiplayerResults").execute();
  },
};
