import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { MediaAsset } from "./mediaAsset";

/** The single media table. `CamelCasePlugin` snake-cases it to `pithy_media_assets` in the DDL. */
export const MEDIA_ASSETS_TABLE = "pithyMediaAssets";

/** The media tables map for a given effective schema (base, or base + adopter extension). */
export function mediaTables(effective: z.ZodObject = MediaAsset): Record<string, z.ZodObject> {
  return { [MEDIA_ASSETS_TABLE]: effective };
}

/** The typed Kysely database over the base media table. Extension columns are read/written by schema. */
export type MediaTables = { [MEDIA_ASSETS_TABLE]: typeof MediaAsset };
export type MediaDatabase = Kysely<DatabaseSchema<MediaTables>>;

/** Build the media database from the `DB` binding (CamelCasePlugin installed). */
export function mediaDatabase(d1: D1Database, effective: z.ZodObject = MediaAsset): MediaDatabase {
  return createDatabase(d1, mediaTables(effective)) as unknown as MediaDatabase;
}
