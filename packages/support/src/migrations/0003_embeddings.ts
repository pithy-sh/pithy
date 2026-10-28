// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The semantic index's model stamps: one row per embedded message in a new
 * `pithy_support_embeddings`.
 *
 * **A `0003`, appended.** The released chain is history, and the messages table is not touched: the stamp
 * describes a derived index, not the mail. The table exists whether or not `search.semantic` is on, because a
 * migration set that varied with a config flag is the ledger corruption `store/searchIndex.ts` records; an
 * empty table costs nothing.
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
