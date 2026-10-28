// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The semantic index's model stamps: one row per embedded message in `pithy_support_embeddings`.
 *
 * **Appended, and the messages table is not touched**: a released migration is never edited, and the stamp
 * describes a derived index, not the mail. The table exists whether or not `search.semantic` is on, because the
 * migration set must not vary with a config flag (`store/searchIndex.ts` says why); an empty table costs nothing.
 *
 * No index beyond the primary key. A reprocess page reads messages in id order and joins this on `messageId`,
 * which the key serves.
 */
export const support_0003_embeddings: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("pithySupportEmbeddings")
      .addColumn("messageId", "text", (c) => c.primaryKey())
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("embeddedAt", "integer", (c) => c.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("pithySupportEmbeddings").execute();
  },
};
