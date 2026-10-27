// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What a management client needs from multiplayer's D1 — #820.
 *
 * **`pithy_multiplayer_sessions` is the index of sessions in flight.** A session is a Durable Object addressed by
 * its id, and nothing could list the live ones without already knowing every id. So a session writes its row here
 * when it opens, rewrites it as its roster or phase moves, and deletes it when it ends — resolved, abandoned by
 * its deadline, closed by its players, or closed by a management client. The Durable Object stays the authority;
 * this is only what the in-flight read lists. `(gameKey, openedAt)` is the index the by-game page is a range scan on.
 *
 * **Three columns on the results** say a result was voided, under which key, and what each consumer did.
 * `voidKey` is **unique**, so one idempotency key cannot void two results; SQLite counts every null as distinct,
 * so the results nobody voided never collide. `voidConsumers` holds each consumer's name and status, never its
 * report: the report names players, and this row outlives the request that read it.
 *
 * **`pithy_multiplayer_void_keys` keeps every key spent on a void.** A retry hands a result's void to a new key, so
 * `voidKey` holds only the latest; this keeps the ones before it, each unique, so a replayed key stays a replay and
 * a key spent on one result never voids another.
 *
 * **Appended, never folded into `0001`.** Multiplayer has shipped, so its results table is history. Nullable with
 * no backfill: no result before this one was voided, and a session already in flight is indexed at its next join,
 * leave or phase change.
 */
export const multiplayer_0002_session_index: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyMultiplayerSessions")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("sessionId", "text", (c) => c.notNull().unique())
      .addColumn("gameKey", "text", (c) => c.notNull())
      .addColumn("phase", "text", (c) => c.notNull())
      .addColumn("players", "text", (c) => c.notNull())
      .addColumn("openedAt", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("pithyMultiplayerSessionsGameIdx")
      .on("pithyMultiplayerSessions")
      .columns(["gameKey", "openedAt"])
      .execute();

    await db.schema.alterTable("pithyMultiplayerResults").addColumn("voidedAt", "integer").execute();
    await db.schema.alterTable("pithyMultiplayerResults").addColumn("voidKey", "text").execute();
    await db.schema.alterTable("pithyMultiplayerResults").addColumn("voidConsumers", "text").execute();
    await db.schema
      .createIndex("pithyMultiplayerResultsVoidKeyIdx")
      .on("pithyMultiplayerResults")
      .column("voidKey")
      .unique()
      .execute();

    await db.schema
      .createTable("pithyMultiplayerVoidKeys")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("voidKey", "text", (c) => c.notNull().unique())
      .addColumn("sessionId", "text", (c) => c.notNull())
      .addColumn("spentAt", "integer", (c) => c.notNull())
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyMultiplayerVoidKeys").execute();
    // The index goes before the column: SQLite refuses to drop a column an index still names.
    await db.schema.dropIndex("pithyMultiplayerResultsVoidKeyIdx").execute();
    await db.schema.alterTable("pithyMultiplayerResults").dropColumn("voidConsumers").execute();
    await db.schema.alterTable("pithyMultiplayerResults").dropColumn("voidKey").execute();
    await db.schema.alterTable("pithyMultiplayerResults").dropColumn("voidedAt").execute();
    await db.schema.dropIndex("pithyMultiplayerSessionsGameIdx").execute();
    await db.schema.dropTable("pithyMultiplayerSessions").execute();
  },
};
