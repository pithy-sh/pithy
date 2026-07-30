// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The document corpus: the durable text and metadata behind every vector in every index.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * Two details are load-bearing. The primary key is **`(indexName, id)`** — text, adopter-supplied, never
 * autoincremented — because the only join between a match and its content is that id, and a second surrogate
 * key would be a second thing to keep in sync. It is composite rather than `id` alone because a vector id is
 * unique *within* a Vectorize index, not across them: two indexes may each hold a document called `intro`,
 * and keying on `id` alone would let a write to one silently overwrite the other's content, metadata, and
 * index. The `CHECK` constraint enforces Vectorize's 64-byte id ceiling in SQLite itself, measured on the id
 * cast to a blob so it counts bytes rather than characters: a row whose id the index cannot address is a row
 * that can be written but never searched, and catching that at insert is far cheaper than discovering it as a
 * permanently missing search result.
 *
 * Two indexes, each for a real read. `(indexName, namespace, id)` is hydration and listing — the path every
 * search result takes. `(indexName, model)` is `pithy vector reprocess`, which scans for rows whose model
 * differs from the configured one; without it that scan is a full table read of the corpus.
 */
export const vector_0001_documents: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyVectorDocuments")
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("indexName", "text", (c) => c.notNull())
      .addColumn("namespace", "text")
      .addColumn("content", "text")
      .addColumn("metadata", "text", (c) => c.notNull().defaultTo("{}"))
      .addColumn("model", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // An id is unique within one Vectorize index, never across them. Two indexes may each hold `intro`.
      .addPrimaryKeyConstraint("pithyVectorDocumentsPk", ["indexName", "id"])
      // Vectorize caps a vector id at 64 bytes. CAST to blob so length() counts bytes, not characters.
      .addCheckConstraint("pithyVectorDocumentsIdLength", sql`length(cast(id as blob)) <= 64`)
      .execute();

    // Hydration and listing: a search returns ids, and this is the read that turns them back into documents.
    await db.schema
      .createIndex("pithyVectorDocumentsIndexIdx")
      .on("pithyVectorDocuments")
      .columns(["indexName", "namespace", "id"])
      .execute();

    // Re-embedding: `pithy vector reprocess` selects the rows whose model differs from the configured one.
    await db.schema
      .createIndex("pithyVectorDocumentsModelIdx")
      .on("pithyVectorDocuments")
      .columns(["indexName", "model"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyVectorDocumentsModelIdx").execute();
    await db.schema.dropIndex("pithyVectorDocumentsIndexIdx").execute();
    await db.schema.dropTable("pithyVectorDocuments").execute();
  },
};
