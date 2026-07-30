// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { ExtensionColumn } from "../data/extend";
import { MEDIA_ASSETS_TABLE } from "../data/tables";

/**
 * The generated `0002_extend` migration: it adds one real column to `pithy_media_assets` per adopter
 * extension field, derived from that field's Zod type (see `data/extend.ts`). This is what makes an
 * adopter's extra fields (an owning `userId`, a tenant id, tags) real, migrated D1 columns from the same
 * one schema that validates them on read and write — with no backend-specific work.
 *
 * A `NOT NULL` column added by `ALTER TABLE` needs a default in SQLite (existing rows must get a value),
 * so a required field is added with a type-appropriate default (`0` / `''`); the effective Zod schema
 * still enforces a real value on every write. Optional fields are added nullable. `down` drops the
 * columns in reverse order. Returns `null` when there is nothing to add, so no empty migration is
 * registered.
 */
export function mediaExtendMigration(columns: ExtensionColumn[]): Migration | null {
  if (columns.length === 0) return null;
  return {
    up: async (db: Kysely<unknown>): Promise<void> => {
      for (const column of columns) {
        await db.schema
          .alterTable(MEDIA_ASSETS_TABLE)
          .addColumn(column.name, column.type, (c) =>
            column.notNull ? c.notNull().defaultTo(column.type === "integer" ? 0 : "") : c,
          )
          .execute();
      }
    },
    down: async (db: Kysely<unknown>): Promise<void> => {
      for (const column of [...columns].reverse()) {
        await db.schema.alterTable(MEDIA_ASSETS_TABLE).dropColumn(column.name).execute();
      }
    },
  };
}
