// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { StorageShare } from "./share";
import { StorageObject } from "./storageObject";

/** The objects table. `CamelCasePlugin` snake-cases it to `pithy_storage_objects`. */
export const STORAGE_OBJECTS_TABLE = "pithyStorageObjects";
/** The share-links table. `CamelCasePlugin` snake-cases it to `pithy_storage_shares`. */
export const STORAGE_SHARES_TABLE = "pithyStorageShares";

/** The storage tables map. Both are always present — neither is behind a config flag. */
export function storageTables(): Record<string, z.ZodObject> {
  return {
    [STORAGE_OBJECTS_TABLE]: StorageObject,
    [STORAGE_SHARES_TABLE]: StorageShare,
  };
}

/** The typed Kysely database over the storage tables. */
export type StorageTables = {
  [STORAGE_OBJECTS_TABLE]: typeof StorageObject;
  [STORAGE_SHARES_TABLE]: typeof StorageShare;
};
export type StorageDatabase = Kysely<DatabaseSchema<StorageTables>>;

/** Build the storage database from the `DB` binding (CamelCasePlugin installed). */
export function storageDatabase(d1: D1Database): StorageDatabase {
  return createDatabase(d1, {
    [STORAGE_OBJECTS_TABLE]: StorageObject,
    [STORAGE_SHARES_TABLE]: StorageShare,
  }) as unknown as StorageDatabase;
}
