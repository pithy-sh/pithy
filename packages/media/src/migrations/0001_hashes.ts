// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the dedup table `pithy_media_hashes`, in the app database. It is created for BOTH record stores
 * (D1 and KV) — dedup is a query workload KV cannot serve, so the hashes always live in D1. One row per
 * media record (`mediaId` unique), so a re-finalize upserts rather than duplicating.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 */
export const media_0001_hashes: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyMediaHashes")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("mediaId", "text", (c) => c.notNull().unique())
      .addColumn("mediaType", "text", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("phash", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // Exact-match dedup looks a row up by sha256; the near-duplicate scan reads the bounded
    // (mediaType, phash) image set.
    await db.schema.createIndex("pithyMediaHashesSha256Idx").on("pithyMediaHashes").column("sha256").execute();
    await db.schema
      .createIndex("pithyMediaHashesPhashIdx")
      .on("pithyMediaHashes")
      .columns(["mediaType", "phash"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMediaHashesPhashIdx").execute();
    await db.schema.dropIndex("pithyMediaHashesSha256Idx").execute();
    await db.schema.dropTable("pithyMediaHashes").execute();
  },
};
