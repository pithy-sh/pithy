// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { DatabaseIntrospector, DatabaseMetadataOptions, SchemaMetadata, TableMetadata } from "kysely";
import { CamelCasePlugin, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

/**
 * The bookkeeping a Pithy database carries beside the tables its capabilities own — the ledger, the
 * lock, the owning project — and the one Kysely every reader and writer of them is built from.
 *
 * It lives apart from the runner because two modules need it: `runner.ts` migrates through it, and
 * `owner.ts` stamps the owning project through it. Sharing the dialect is not a convenience — the
 * introspector below is a workaround, and a second copy of it would drift.
 *
 * Kysely's `Migrator` checks for its bookkeeping tables through the dialect's introspector, and the
 * stock `SqliteIntrospector` joins `pragma_table_info(...)` — a table-valued pragma D1 rejects with
 * `SQLITE_AUTH`. So this dialect's introspector reads `sqlite_master` alone, which is all the
 * `Migrator` needs (table names). `CamelCasePlugin` is installed like every Pithy database — write
 * camelCase, store snake_case.
 */

/** The `sqlite_master` rows the introspector reads; D1 permits plain selects against it. */
interface SqliteMasterDatabase {
  sqlite_master: { name: string; type: string };
}

/**
 * The applied-migration ledger. Renamed off Kysely's `kysely_migration` default: an adopter running
 * their own Kysely migrations on the same D1 would otherwise collide on it (principle 1).
 */
export const MIGRATION_TABLE = "pithy_migrations";

/** The migration lock, renamed off Kysely's `kysely_migration_lock` default for the same reason. */
export const MIGRATION_LOCK_TABLE = "pithy_migrations_lock";

/**
 * The owning project's stamp — one row, written by `claimMigrationOwnership`, read by `pithy migrate`
 * before it applies anything. Deliberately *beside* the ledger rather than inside it: it is not a
 * migration, so a rollback or a full reset must not remove it, and no capability has to ship it.
 */
export const MIGRATION_OWNER_TABLE = "pithy_migrations_owner";

/** Pithy's bookkeeping tables — hidden by the introspector the way Kysely hides its own defaults. */
const INTERNAL_TABLES = [MIGRATION_TABLE, MIGRATION_LOCK_TABLE, MIGRATION_OWNER_TABLE];

/** Table names from `sqlite_master` only — no pragma joins, no column metadata. */
class D1Introspector implements DatabaseIntrospector {
  readonly #db: Kysely<SqliteMasterDatabase>;

  constructor(db: Kysely<SqliteMasterDatabase>) {
    this.#db = db;
  }

  async getSchemas(): Promise<SchemaMetadata[]> {
    return [];
  }

  async getTables(options: DatabaseMetadataOptions = { withInternalKyselyTables: false }): Promise<TableMetadata[]> {
    let query = this.#db
      .selectFrom("sqlite_master")
      .where("type", "in", ["table", "view"])
      .where("name", "not like", "sqlite_%")
      .select(["name", "type"])
      .orderBy("name");
    if (!options.withInternalKyselyTables) {
      query = query.where("name", "not in", INTERNAL_TABLES);
    }
    const rows = await query.execute();
    return rows.map((row) => ({ name: row.name, isView: row.type === "view", isForeign: false, columns: [] }));
  }
}

/** The D1 dialect Pithy migrates through: stock kysely-d1, with the `sqlite_master`-only introspector. */
export class D1MigrationDialect extends D1Dialect {
  override createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new D1Introspector(db as Kysely<SqliteMasterDatabase>);
  }
}

/** A Kysely over one D1 binding, with Pithy's dialect and `CamelCasePlugin` — the one way in. */
export function migrationKysely<DB = unknown>(database: D1Database): Kysely<DB> {
  return new Kysely<DB>({ dialect: new D1MigrationDialect({ database }), plugins: [new CamelCasePlugin()] });
}
