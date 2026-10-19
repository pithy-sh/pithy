// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create `pithy_secrets_tables`, the registry of declared secret tables the at-rest rotation sweeps
 * (`../data/secretTables`).
 *
 * **Appended, never folded into `0001`.** `@pithy-sh/secrets` shipped, so `0001_init` is history: a database
 * already running it gains this table from this migration and from nothing else.
 *
 * The rows are written by the migrations `pithy migrate` generates for each declared table, which sort
 * after this one in the `secrets` database — so a rollback reverses them first, and by the time this
 * `down` runs nothing is registered.
 */
export const secrets_0002_tables: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithySecretsTables")
      .addColumn("name", "text", (c) => c.primaryKey())
      .addColumn("keys", "text", (c) => c.notNull())
      .addColumn("secrets", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithySecretsTables").execute();
  },
};
