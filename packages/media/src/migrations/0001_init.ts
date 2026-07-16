import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the single media table, `pithy_media_assets`, in the app database. One table with a `type`
 * discriminator and nullable per-type derived columns, rather than a table per media type. The
 * `pithy_media_` prefix keeps it clear of an adopter's own tables (CLAUDE.md §Data layer).
 *
 * Identifiers are declared in **camelCase**: the runner installs `CamelCasePlugin`, which snake-cases
 * every identifier in the emitted DDL. `down` is the tested inverse — indexes then table, in reverse
 * creation order (D1 has no transactional DDL). Adopter extension columns land in `0002_extend`.
 */
export const media_0001_init: Migration = {
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

    // Exact-match dedup looks a record up by its sha256; near-duplicate image search scans the bounded
    // (type, phash) set; list/filter by type is common.
    await db.schema.createIndex("pithyMediaAssetsTypeIdx").on("pithyMediaAssets").column("type").execute();
    await db.schema.createIndex("pithyMediaAssetsSha256Idx").on("pithyMediaAssets").column("sha256").execute();
    await db.schema.createIndex("pithyMediaAssetsPhashIdx").on("pithyMediaAssets").columns(["type", "phash"]).execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyMediaAssetsPhashIdx").execute();
    await db.schema.dropIndex("pithyMediaAssetsSha256Idx").execute();
    await db.schema.dropIndex("pithyMediaAssetsTypeIdx").execute();
    await db.schema.dropTable("pithyMediaAssets").execute();
  },
};
