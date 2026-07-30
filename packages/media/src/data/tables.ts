// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { MediaAsset } from "./mediaAsset";
import { MediaHash } from "./mediaHash";

/** The media record table. `CamelCasePlugin` snake-cases it to `pithy_media_assets` in the DDL. */
export const MEDIA_ASSETS_TABLE = "pithyMediaAssets";
/** The dedup hash table. `CamelCasePlugin` snake-cases it to `pithy_media_hashes`. */
export const MEDIA_HASHES_TABLE = "pithyMediaHashes";

/**
 * The media tables map for a given effective schema. The hash table is always present (dedup is D1-only);
 * the record table is present for the D1 record store and omitted for `recordStore: 'kv'`.
 */
export function mediaTables(
  effective: z.ZodObject = MediaAsset,
  options: { withAssets?: boolean } = {},
): Record<string, z.ZodObject> {
  const tables: Record<string, z.ZodObject> = { [MEDIA_HASHES_TABLE]: MediaHash };
  if (options.withAssets !== false) tables[MEDIA_ASSETS_TABLE] = effective;
  return tables;
}

/** The typed Kysely database over the base media record table. Extension columns are read/written by schema. */
export type MediaTables = { [MEDIA_ASSETS_TABLE]: typeof MediaAsset };
export type MediaDatabase = Kysely<DatabaseSchema<MediaTables>>;

/** Build the record database from the `DB` binding (CamelCasePlugin installed). */
export function mediaDatabase(d1: D1Database, effective: z.ZodObject = MediaAsset): MediaDatabase {
  return createDatabase(d1, { [MEDIA_ASSETS_TABLE]: effective }) as unknown as MediaDatabase;
}

/** The typed Kysely database over the dedup hash table. */
export type MediaHashTables = { [MEDIA_HASHES_TABLE]: typeof MediaHash };
export type MediaHashDatabase = Kysely<DatabaseSchema<MediaHashTables>>;

/** Build the hash database from the `DB` binding. */
export function mediaHashDatabase(d1: D1Database): MediaHashDatabase {
  return createDatabase(d1, { [MEDIA_HASHES_TABLE]: MediaHash }) as unknown as MediaHashDatabase;
}
