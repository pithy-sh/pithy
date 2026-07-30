// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Create the two secrets tables in the per-environment secrets D1. Both carry the
 * `pithy_secrets_` prefix so they never clash with an adopter's own tables.
 *
 * Identifiers — table, index, and column names — are declared in **camelCase**: the
 * runner installs `CamelCasePlugin`, which snake-cases every identifier in the emitted
 * DDL. So we never hand-write snake_case (CLAUDE.md §Data layer); the `pithy_secrets_`
 * snake form exists only in the actual database. `pithySecretsSystemSecrets` becomes the
 * SQL table `pithy_secrets_system_secrets`, and the column names match the Zod schemas.
 *
 * `down` is the tested inverse: drop both tables. D1 has no transactional DDL, so the
 * order is deliberate — the rotations index and table first, then the secrets table.
 */
export const secrets_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithySecretsSystemSecrets")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull().unique())
      .addColumn("encryptedValue", "text", (c) => c.notNull())
      .addColumn("iv", "text", (c) => c.notNull())
      .addColumn("keyVersion", "integer", (c) => c.notNull())
      .addColumn("valueType", "text", (c) => c.notNull().defaultTo("text"))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("pithySecretsRotations")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("startedAt", "integer", (c) => c.notNull())
      .addColumn("completedAt", "integer")
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("trigger", "text", (c) => c.notNull())
      .addColumn("rotatedBy", "text", (c) => c.notNull())
      .addColumn("errorMessage", "text")
      .addColumn("metadataSnapshot", "text")
      .execute();

    await db.schema.createIndex("pithySecretsRotationsNameIdx").on("pithySecretsRotations").column("name").execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithySecretsRotations").execute();
    await db.schema.dropTable("pithySecretsSystemSecrets").execute();
  },
};
