import type { D1Database } from "@cloudflare/workers-types";
import type { DatabaseIntrospector, DatabaseMetadataOptions, SchemaMetadata, TableMetadata } from "kysely";
import { CamelCasePlugin, Kysely } from "kysely";
import { type MigrationProvider, type MigrationResult, Migrator } from "kysely/migration";
import { D1Dialect } from "kysely-d1";
import { InternalError } from "../error/pithyError";

/**
 * The per-database migration runner. The registry yields one `MigrationProvider` per database
 * (`createMigrationRegistry`); the caller pairs each provider with that database's D1 binding and
 * runs them independently — there is no global run across databases. `pithy migrate` is a thin
 * wrapper over these two functions.
 *
 * Both take the raw binding, not a Kysely instance: Kysely's `Migrator` checks for its bookkeeping
 * tables through the dialect's introspector, and the stock `SqliteIntrospector` joins
 * `pragma_table_info(...)` — a table-valued pragma D1 rejects with `SQLITE_AUTH`. So the runner
 * builds its own Kysely over a dialect whose introspector reads `sqlite_master` alone, which is all
 * the `Migrator` needs (table names). Migration `up`/`down` functions receive that instance, with
 * `CamelCasePlugin` installed like every Pithy database — write camelCase, store snake_case.
 *
 * One runner at a time per database. D1 has no transactional DDL and its adapter's migration lock
 * is a no-op, so concurrent runs can interleave. That fits the deployment model — migrations run
 * from `pithy migrate` (CLI/CI), not inside request handlers — but it is an assumption, not a
 * guard. On failure the thrown `InternalError` names the failed key in `message` and lists the
 * migrations applied before the failure in `detail`, since those stay applied.
 */

/** The `sqlite_master` rows the introspector reads; D1 permits plain selects against it. */
interface SqliteMasterDatabase {
  sqlite_master: { name: string; type: string };
}

const KYSELY_TABLES = ["kysely_migration", "kysely_migration_lock"];

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
      query = query.where("name", "not in", KYSELY_TABLES);
    }
    const rows = await query.execute();
    return rows.map((row) => ({ name: row.name, isView: row.type === "view", isForeign: false, columns: [] }));
  }
}

class D1MigrationDialect extends D1Dialect {
  override createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new D1Introspector(db as Kysely<SqliteMasterDatabase>);
  }
}

function migrator(database: D1Database, provider: MigrationProvider): Migrator {
  const db = new Kysely<unknown>({
    dialect: new D1MigrationDialect({ database }),
    plugins: [new CamelCasePlugin()],
  });
  return new Migrator({ db, provider });
}

/** Run every pending migration to latest. An empty provider resolves to `[]`. */
export async function runMigrations(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateToLatest();
  return settle("run", error, results);
}

/** Step the latest applied migration back — one step, the `pithy migrate --rollback` seam. */
export async function rollbackMigration(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateDown();
  return settle("rollback", error, results);
}

/** Brand-voice problem and action lines per direction (docs/CLI.md §3.3). */
const VOICE = {
  run: {
    failed: (key: string) => `Couldn't apply "${key}".`,
    fallback: "Migration run failed.",
    action: "Fix the migration. Run pithy migrate again.",
  },
  rollback: {
    failed: (key: string) => `Couldn't roll back "${key}".`,
    fallback: "Rollback failed.",
    action: "Fix the migration. Run pithy migrate --rollback again.",
  },
} as const;

function settle(verb: keyof typeof VOICE, error: unknown, results: MigrationResult[] | undefined): MigrationResult[] {
  if (error !== undefined) {
    const voice = VOICE[verb];
    const failed = results?.find((result) => result.status === "Error");
    const applied = results?.filter((result) => result.status === "Success").map((result) => result.migrationName);
    const cause = error instanceof Error ? error.message : String(error);
    throw new InternalError(
      {
        message: failed ? voice.failed(failed.migrationName) : voice.fallback,
        // D1 applies migrations non-transactionally, so name what stuck before the failure.
        detail: applied?.length
          ? `${cause}. Applied before the failure: ${applied.map((name) => `"${name}"`).join(", ")}.`
          : cause,
        action: voice.action,
      },
      { cause: error },
    );
  }
  return results ?? [];
}
