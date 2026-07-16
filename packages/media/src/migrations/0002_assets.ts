import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the media record table, `pithy_media_assets`, in the app database — for the D1 record store only
 * (`recordStore: 'kv'` keeps records in KV and skips this migration). One table with a `type` discriminator
 * and nullable per-type derived columns. `sha256`/`phash` are kept on the record for reference, but dedup
 * queries the dedicated `pithy_media_hashes` table (see `0001_hashes.ts`), so those columns are not indexed
 * here.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 * Adopter extension columns land in `0003_extend`.
 */
export const media_0002_assets: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
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
  },
};
