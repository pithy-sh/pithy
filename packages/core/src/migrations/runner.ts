import type { D1Database } from "@cloudflare/workers-types";
import type { DatabaseIntrospector, DatabaseMetadataOptions, SchemaMetadata, TableMetadata } from "kysely";
import { CamelCasePlugin, Kysely, sql } from "kysely";
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
 * The bookkeeping ledger and lock are renamed off Kysely's `kysely_migration` defaults to
 * `pithy_migrations` / `pithy_migrations_lock` — an adopter running their own Kysely migrations on
 * the same D1 would otherwise collide on those default names (principle 1). The introspector's
 * internal-table filter tracks the rename so `getTables` still hides them.
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

/** Pithy's renamed bookkeeping tables — hidden by the introspector like Kysely's defaults are. */
const MIGRATION_TABLE = "pithy_migrations";
const MIGRATION_LOCK_TABLE = "pithy_migrations_lock";
const INTERNAL_TABLES = [MIGRATION_TABLE, MIGRATION_LOCK_TABLE];

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
  return new Migrator({
    db,
    provider,
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });
}

/** Run every pending migration to latest. An empty provider resolves to `[]`. */
export async function runMigrations(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateToLatest();
  return settle("run", error, results);
}

/**
 * Count the migrations that have not run yet — read-only, applying nothing. The seam behind
 * `pithy deploy`'s warn-only check: deploy never migrates, but it can tell you the target env's
 * schema is behind.
 */
export async function pendingMigrations(database: D1Database, provider: MigrationProvider): Promise<number> {
  const migrations = await migrator(database, provider).getMigrations();
  return migrations.filter((migration) => migration.executedAt === undefined).length;
}

/** Step the latest applied migration back — one step, the `pithy migrate --rollback` seam. */
export async function rollbackMigration(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateDown();
  return settle("rollback", error, results);
}

/**
 * The applied migration names recorded in the ledger — empty when the ledger table doesn't exist yet.
 * Existence is checked against `sqlite_master` (a plain select D1 permits) rather than by catching the
 * read's error, so a genuine read failure surfaces instead of being silently treated as "none applied".
 */
async function appliedMigrationNames(db: Kysely<unknown>): Promise<Set<string>> {
  const present = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name = ${MIGRATION_TABLE}`.execute(db);
  if (present.rows.length === 0) return new Set();
  const { rows } = await sql<{ name: string }>`select name from ${sql.table(MIGRATION_TABLE)}`.execute(db);
  return new Set(rows.map((row) => row.name));
}

/**
 * Surgically drop **one capability's** migrations: run each of the provider's `down` functions in
 * reverse order and delete only those ledger rows, leaving every other capability's tables and
 * bookkeeping untouched. The seam behind `pithy remove --drop`. Kysely's stepwise `Migrator` refuses a
 * provider that doesn't span the whole ledger (it reads a foreign row as corrupt state), so a
 * per-capability drop can't go through it — this reverses the capability's own migrations directly.
 * Only migrations recorded in the ledger are reversed; an absent ledger drops nothing.
 */
export async function dropMigrations(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const db = new Kysely<unknown>({ dialect: new D1MigrationDialect({ database }), plugins: [new CamelCasePlugin()] });
  const migrations = await provider.getMigrations();
  const applied = await appliedMigrationNames(db);

  const results: MigrationResult[] = [];
  // Reverse application order: drop the newest of the capability's migrations first.
  for (const name of Object.keys(migrations).sort().reverse()) {
    if (!applied.has(name)) continue;
    // No `down` — the migration can't be reversed, so leave both its table and its ledger row in place
    // (deleting the row would desync the ledger from the schema). Every Pithy migration ships a `down`.
    const down = migrations[name]?.down;
    if (!down) continue;
    try {
      await down(db);
      await sql`delete from ${sql.table(MIGRATION_TABLE)} where name = ${name}`.execute(db);
      results.push({ migrationName: name, direction: "Down", status: "Success" });
    } catch (error) {
      const dropped = results.map((result) => `"${result.migrationName}"`);
      const cause = error instanceof Error ? error.message : String(error);
      throw new InternalError(
        {
          message: `Couldn't drop "${name}".`,
          detail: dropped.length ? `${cause}. Dropped before the failure: ${dropped.join(", ")}.` : cause,
          action: "Fix the migration's down, or drop its table by hand. Run pithy remove --drop again.",
        },
        { cause: error },
      );
    }
  }
  return results;
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
