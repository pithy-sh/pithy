// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Kysely, sql } from "kysely";
import { type MigrationProvider, type MigrationResult, Migrator, NO_MIGRATIONS } from "kysely/migration";
import { InternalError } from "../error/pithyError";
import { MIGRATION_LOCK_TABLE, MIGRATION_TABLE, migrationKysely } from "./bookkeeping";

/**
 * The per-database migration runner. The registry yields one `MigrationProvider` per database
 * (`createMigrationRegistry`); the caller pairs each provider with that database's D1 binding and
 * runs them independently — there is no global run across databases. `pithy migrate` is a thin
 * wrapper over these two functions.
 *
 * Both take the raw binding, not a Kysely instance: the dialect, the `CamelCasePlugin`, and the
 * renamed bookkeeping tables all live in `./bookkeeping`, and the runner builds its Kysely from
 * there (`owner.ts` builds the same one to stamp the owning project). Migration `up`/`down`
 * functions receive that instance — write camelCase, store snake_case, like every Pithy database.
 *
 * One runner at a time per database. D1 has no transactional DDL and its adapter's migration lock
 * is a no-op, so concurrent runs can interleave. That fits the deployment model — migrations run
 * from `pithy migrate` (CLI/CI), not inside request handlers — but it is an assumption, not a
 * guard. On failure the thrown `InternalError` names the failed key in `message` and lists the
 * migrations applied before the failure in `detail`, since those stay applied.
 */

/**
 * **`allowUnorderedMigrations` is on, and it is not a loosening.** A composed key leads with its
 * capability's `migrationOrder` (`0250_audit_0001_init`), so the sorted registry *is* the order Pithy
 * promises — and it is the same order whatever sequence an adopter typed `pithy add` in. Kysely's
 * default mode additionally requires the applied ledger to be a prefix of that order, which nothing in
 * the model can guarantee: add `email` (200), then `auth` (300), then `audit` (250), and audit's
 * migration sorts between two applied ones. Every later run then failed, naming keys and index
 * positions the adopter never chose, and the only recovery was wiping the database.
 *
 * Unordered mode still applies pending migrations in `migrationOrder`. It drops one thing: the demand
 * that the past agree with it. That is sound here because no capability's tables reference another's
 * — order across capabilities is arbitrary by design, and order *within* one is preserved, since a
 * capability arrives with its whole set. Refusing the add with an actionable error was the
 * alternative; it explains the corner instead of removing it.
 */
function migrator(database: D1Database, provider: MigrationProvider): Migrator {
  return new Migrator({
    db: migrationKysely(database),
    provider,
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
    allowUnorderedMigrations: true,
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
 * Fully reset one database's schema: every applied migration's `down` runs, in one pass, in reverse
 * chronological order — Kysely's `NO_MIGRATIONS` target, not just the latest — then every migration's
 * `up` reapplies from empty. The seam behind `pithy seed --redo`'s destructive rebuild: because the
 * schema comes back empty, the ordinary non-destructive seed writes (`INSERT OR IGNORE`, KV
 * skip-if-exists) simply work afterward — there is no per-row identity problem to solve. An empty
 * ledger rolls back nothing; an empty provider reapplies nothing.
 */
export async function resetMigrations(database: D1Database, provider: MigrationProvider): Promise<MigrationResult[]> {
  const runner = migrator(database, provider);
  const down = await runner.migrateTo(NO_MIGRATIONS);
  const downResults = settle("resetDown", down.error, down.results);
  const up = await runner.migrateToLatest();
  const upResults = settle("resetUp", up.error, up.results);
  return [...downResults, ...upResults];
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
  const db = migrationKysely(database);
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
  resetDown: {
    failed: (key: string) => `Couldn't roll back "${key}" during reset.`,
    fallback: "Schema reset failed while rolling back.",
    action: "Fix the migration. Run pithy seed --redo again.",
  },
  resetUp: {
    failed: (key: string) => `Couldn't reapply "${key}" during reset.`,
    fallback: "Schema reset failed while reapplying.",
    action: "Fix the migration. Run pithy seed --redo again.",
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
