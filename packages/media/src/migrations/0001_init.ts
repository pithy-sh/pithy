// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The media schema in the app database as it first shipped: the dedup hash table and the record table.
 *
 * It used to be parameterized by a `withAssets` flag, false for the KV record store, which kept records in
 * KV and only the hashes here. That store was removed, so the flag went with it and this is the one shape
 * it always produced for D1 — the same tables, the same columns, the same indexes, so a database that
 * already ran it is unchanged by the edit. Ownership, organization and visibility arrive in
 * `0003_ownership`, because the chain is append-only once a capability has shipped.
 *
 * One table with a `type` discriminator and nullable per-type derived columns; `sha256`/`phash` are kept
 * on the record for reference, but dedup queries the dedicated hash table, so those columns are not
 * indexed here. Adopter extension columns arrive in the generated `0002_extend` migration (`extend.ts`),
 * which is derived per adopter from their extension schema and is not part of this authored schema.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * See `CONTRIBUTING.md` §Migrations for why a released capability's chain is append-only.
 */
export const media_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyMediaHashes")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      // One row per media record, so a re-finalize upserts rather than duplicating.
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

    await db.schema
      .createTable("pithyMediaAssets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("filename", "text", (c) => c.notNull())
      .addColumn("contentType", "text", (c) => c.notNull())
      .addColumn("size", "integer")
      .addColumn("storageBackend", "text", (c) => c.notNull())
      .addColumn("storageKey", "text", (c) => c.notNull())
      .addColumn("sha256", "text")
      .addColumn("phash", "text")
      .addColumn("width", "integer")
      .addColumn("height", "integer")
      .addColumn("altText", "text")
      .addColumn("caption", "text")
      .addColumn("transcription", "text")
      .addColumn("hasTranscription", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("extractedText", "text")
      .addColumn("hasExtractedText", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    // List/filter by type is the common query; dedup uses pithy_media_hashes, not this table.
    await db.schema.createIndex("pithyMediaAssetsTypeIdx").on("pithyMediaAssets").column("type").execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMediaAssetsTypeIdx").execute();
    await db.schema.dropTable("pithyMediaAssets").execute();
    await db.schema.dropIndex("pithyMediaHashesPhashIdx").execute();
    await db.schema.dropIndex("pithyMediaHashesSha256Idx").execute();
    await db.schema.dropTable("pithyMediaHashes").execute();
  },
};
