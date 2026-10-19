// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { DatabaseSpec } from "@pithy-sh/core/src/data/databases";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import type { z } from "zod";
import { type AnySecretTable, isSecretTable, secretTableRow } from "./defineSecretTable";

/**
 * Where declared tables are composed: the app capability's `SECRETS` database spec.
 *
 * ```ts
 * import { secretTableMigrations } from "./migrations/secrets";
 *
 * databases: { secrets: secretTablesDatabase({ tables: [CustomerSecrets], migrations: secretTableMigrations }) }
 * ```
 *
 * One call, because three things must agree and an adopter should write none of them twice: the binding
 * (`SECRETS`, the vault the secrets capability declares), each table's row schema (so `c.var.db.secrets` is
 * typed over it), and the migrations `pithy migrate` writes into `migrations/secrets/` beside the Worker's
 * config. The tables travel on the spec as `secretTables`, which is how `pithy migrate` finds a declaration to
 * diff and `pithy secrets tables` finds one to report.
 *
 * **Every declared table is retained** (`DatabaseSpec.retained`). Its rows are customers' credentials, which
 * exist here and at whoever issued them and nowhere else, so no `down` runs against the database while one
 * holds rows unless the operator counts them (#588) — the same protection the system table has.
 */

/**
 * The sort order of declared-table migrations within the `secrets` database — after the secrets capability's
 * own (`100`), so `pithy_secrets_tables` exists before the first table registers in it. Allocated in
 * `packages/cli/src/migrations/orders.test.ts`, like every other order.
 */
export const SECRET_TABLES_MIGRATION_ORDER = 1500;

/** The `secrets` database spec a set of declared tables is composed through. */
export interface SecretTablesDatabaseSpec extends DatabaseSpec<Record<string, z.ZodType>> {
  /** The declared tables, for `pithy migrate` and `pithy secrets tables`. */
  readonly secretTables: readonly AnySecretTable[];
}

/** What {@link secretTablesDatabase} takes. */
export interface SecretTablesDatabaseOptions {
  /** Every table this Worker declares. */
  tables: readonly AnySecretTable[];
  /**
   * The migrations `pithy migrate` wrote for them — `secretTableMigrations` from `migrations/secrets/index.ts`.
   * Absent before the first `pithy migrate` has written any.
   */
  migrations?: Record<string, Migration>;
}

/** Compose declared tables into the `SECRETS` database. */
export function secretTablesDatabase(options: SecretTablesDatabaseOptions): SecretTablesDatabaseSpec {
  const seen = new Set<string>();
  const tables: Record<string, z.ZodType> = {};
  for (const table of options.tables) {
    if (!isSecretTable(table)) {
      throw new InternalError({
        message: "secretTablesDatabase: every table must come from defineSecretTable.",
      });
    }
    if (seen.has(table.name)) {
      throw new InternalError({ message: `secretTablesDatabase: table "${table.name}" is declared twice.` });
    }
    seen.add(table.name);
    tables[table.identifier] = secretTableRow(table);
  }
  const migrations = options.migrations;
  const hasMigrations = migrations !== undefined && Object.keys(migrations).length > 0;
  return {
    binding: "SECRETS",
    tables,
    secretTables: options.tables,
    ...(hasMigrations
      ? { migrations, migrationOrder: SECRET_TABLES_MIGRATION_ORDER, retained: Object.keys(tables) }
      : {}),
  };
}

/** Whether a database spec composes declared tables. */
export function isSecretTablesDatabase(spec: DatabaseSpec): spec is SecretTablesDatabaseSpec {
  const tables = (spec as { secretTables?: unknown }).secretTables;
  return Array.isArray(tables) && tables.every(isSecretTable);
}

/** One spec's declared tables, with where they were composed. */
export interface DeclaredSecretTables {
  /** The capability that composes them — the migrations' namespace. */
  capability: string;
  /** The database key the spec sits under. */
  database: string;
  /** The tables it declares. */
  tables: readonly AnySecretTable[];
  /** The migrations it composes for them, empty before the first was written. */
  migrations: Record<string, Migration>;
}

/** Every declared table a composition carries, in capability order. */
export function declaredSecretTables(capabilities: readonly Capability[]): DeclaredSecretTables[] {
  const found: DeclaredSecretTables[] = [];
  for (const capability of capabilities) {
    for (const [database, spec] of Object.entries(capability.databases ?? {})) {
      if (!isSecretTablesDatabase(spec)) continue;
      found.push({
        capability: capability.name,
        database,
        tables: spec.secretTables,
        migrations: spec.migrations ?? {},
      });
    }
  }
  return found;
}
