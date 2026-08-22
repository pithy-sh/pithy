// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** What the media schema looks like in the app database, which depends on where records live. */
export interface MediaInitOptions {
  /**
   * Whether to create the record table `pithy_media_assets`. True for `recordStore: 'd1'`; false for
   * `recordStore: 'kv'`, where records live in KV and only the dedup hash table belongs in D1.
   */
  readonly withAssets: boolean;
}

/**
 * The whole media schema in the app database, in one migration — parameterized rather than chained,
 * because what media creates there is a function of its record store and not of its history.
 *
 * `pithy_media_hashes` is created in **both** modes: dedup is a query workload (an exact `sha256`
 * lookup and a bounded near-`phash` scan) that KV cannot serve, so the hashes always live in D1. The
 * record table `pithy_media_assets` is created for the D1 record store only, which is what
 * `withAssets` selects. One table with a `type` discriminator and nullable per-type derived columns;
 * `sha256`/`phash` are kept on the record for reference, but dedup queries the dedicated hash table,
 * so those columns are not indexed here. Adopter extension columns arrive in the generated
 * `0002_extend` migration (`extend.ts`), which is derived per adopter from their extension schema and
 * is not part of this authored schema.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse,
 * dropping in reverse of what `up` created for the same options.
 *
 * **`recordStore` is chosen once, not migrated between.** A project that flips `kv` → `d1` after its
 * first `pithy migrate` gets no record table, because this migration has already run. That was never a
 * working path: the previous two-migration form would have created an empty table and left every
 * existing record stranded in KV, unreadable and unlisted. Changing record store means a new database
 * and a deliberate copy, not a schema step.
 *
 * See `CONTRIBUTING.md` §Migrations for why a capability's schema is one migration while nothing is
 * published, and what changes the day something is.
 */
export function media_0001_init({ withAssets }: MediaInitOptions): Migration {
  return {
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

      if (!withAssets) return;

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
      if (withAssets) {
        await db.schema.dropIndex("pithyMediaAssetsTypeIdx").execute();
        await db.schema.dropTable("pithyMediaAssets").execute();
      }
      await db.schema.dropIndex("pithyMediaHashesPhashIdx").execute();
      await db.schema.dropIndex("pithyMediaHashesSha256Idx").execute();
      await db.schema.dropTable("pithyMediaHashes").execute();
    },
  };
}
