// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Kysely, sql } from "kysely";
import { type MigrationProvider, type MigrationResult, Migrator, NO_MIGRATIONS } from "kysely/migration";
import { causeMessage } from "../error/cause";
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
 * guard. On failure the thrown `InternalError` names the failed key, the database it was running
 * against, and **what the runtime actually said**, all in `message`; `detail` keeps the throw-site
 * half — the database name behind the binding, and the migrations applied before the failure, since
 * those stay applied.
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

/**
 * Which database a run is reporting on — what a failure names.
 *
 * Optional at every entry point, and defaulted the same way `claimMigrationOwnership`'s refusal defaults
 * its own binding — a runner handed nothing still has a sentence. The CLI always passes one, from the
 * group it is running, because "which database" is the first question a failed migration raises and the
 * runner is the only place that can answer it in the same breath as the error (#282).
 */
export interface MigrationTarget {
  /** The D1 binding, as `wrangler.jsonc` declares it — the name an adopter recognises. */
  binding: string;
  /** The database name: a capability's `databases` key. Throw-site context, not the adopter's handle. */
  database: string;
}

/** Run every pending migration to latest. An empty provider resolves to `[]`. */
export async function runMigrations(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateToLatest();
  return settle("run", error, results, target);
}

/** One database's ledger beside the declaration it is supposed to match — see {@link readMigrationLedger}. */
export interface MigrationLedger {
  /** Declared and not yet applied, in the order they would run. */
  pending: string[];
  /**
   * Applied and no longer declared, sorted. Kysely refuses the whole chain on any one of these, so
   * this is not drift a later run works around — it is the reason nothing can run at all.
   */
  undeclared: string[];
}

/**
 * What this database has applied, against what this project declares — **both directions, one read**.
 *
 * `pithy doctor` used to ask only how many declared migrations had not run, because that is the
 * question Kysely's own `getMigrations` answers: it maps over the *provider's* migrations and looks
 * each one up in the ledger, so a row the provider does not carry is not in the result at all. A
 * subtraction cannot see an extra. A database holding a migration the project has since deleted
 * therefore reported `none pending ✓` while the migrator refused to run against it at all — Kysely
 * reads an unrecognised applied migration as a corrupted chain and applies nothing (#282).
 *
 * Asking both halves in one function is the point. Two functions — one counting pending, one hunting
 * undeclared — is how the first half shipped alone, and the caller reaching for the count is exactly
 * the caller who needs the other answer.
 *
 * Read-only, applying nothing: the seam behind `pithy doctor`'s migrations line, `pithy deploy`'s
 * warn-only "schema is behind" check, and the refusal `pithy migrate` raises before it writes.
 */
export async function readMigrationLedger(database: D1Database, provider: MigrationProvider): Promise<MigrationLedger> {
  const declared = Object.keys(await provider.getMigrations()).sort();
  const applied = await appliedMigrationNames(migrationKysely(database));
  return {
    pending: declared.filter((name) => !applied.has(name)),
    undeclared: [...applied].filter((name) => !declared.includes(name)).sort(),
  };
}

/** Step the latest applied migration back — one step, the `pithy migrate --rollback` seam. */
export async function rollbackMigration(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider).migrateDown();
  return settle("rollback", error, results, target);
}

/**
 * Fully reset one database's schema: every applied migration's `down` runs, in one pass, in reverse
 * chronological order — Kysely's `NO_MIGRATIONS` target, not just the latest — then every migration's
 * `up` reapplies from empty. The seam behind `pithy seed --redo`'s destructive rebuild: because the
 * schema comes back empty, the ordinary non-destructive seed writes (`INSERT OR IGNORE`, KV
 * skip-if-exists) simply work afterward — there is no per-row identity problem to solve. An empty
 * ledger rolls back nothing; an empty provider reapplies nothing.
 */
export async function resetMigrations(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
): Promise<MigrationResult[]> {
  const runner = migrator(database, provider);
  const down = await runner.migrateTo(NO_MIGRATIONS);
  const downResults = settle("resetDown", down.error, down.results, target);
  const up = await runner.migrateToLatest();
  const upResults = settle("resetUp", up.error, up.results, target);
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
export async function dropMigrations(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
): Promise<MigrationResult[]> {
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
      throw new InternalError(
        {
          message: `Couldn't drop "${name}"${on(target)}. ${reasonOf(error)}`,
          detail: `${where(target)}${dropped.length ? ` Dropped before the failure: ${dropped.join(", ")}.` : ""}`,
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
    failed: (key: string) => `Couldn't apply "${key}"`,
    fallback: "The migration run failed",
    action: "Fix the migration. Run pithy migrate again.",
  },
  rollback: {
    failed: (key: string) => `Couldn't roll back "${key}"`,
    fallback: "The rollback failed",
    action: "Fix the migration. Run pithy migrate --rollback again.",
  },
  resetDown: {
    failed: (key: string) => `Couldn't roll back "${key}" during reset`,
    fallback: "The schema reset failed while rolling back",
    action: "Fix the migration. Run pithy seed --redo again.",
  },
  resetUp: {
    failed: (key: string) => `Couldn't reapply "${key}" during reset`,
    fallback: "The schema reset failed while reapplying",
    action: "Fix the migration. Run pithy seed --redo again.",
  },
} as const;

/** ` on DB`, or nothing at all — every problem line here ends with this and then a period. */
function on(target: MigrationTarget | undefined): string {
  return target ? ` on ${target.binding}` : "";
}

/** The throw-site half of the same fact: the database name behind the binding, for `detail`. */
function where(target: MigrationTarget | undefined): string {
  return target ? `Database "${target.database}" on binding ${target.binding}.` : "";
}

/**
 * The underlying failure, as a sentence — **in `message`, where it is actually rendered**.
 *
 * It used to go to `detail` alone, and `detail` is the field the terminal renderer never prints and the
 * HTTP codec strips. So `pithy migrate` said *Migration run failed. Fix the migration.* and nothing
 * else, over a Kysely error that had already named the migration and the reason (#282). A migration
 * failure is D1 answering our own SQL — `no such column: tenant`, `corrupted migrations: previously
 * executed migration X is missing` — and that sentence *is* the actionable content. Withholding it is
 * not a security boundary, it is the bug.
 *
 * Deliberately not through `safeReason`: that filter drops anything over 160 characters, and a silent
 * drop is what this whole path is being fixed for. Colour codes come off, because they are formatting
 * a runtime added.
 */
function reasonOf(error: unknown): string {
  const reason = (causeMessage(error) ?? String(error)).trim();
  return reason.endsWith(".") ? reason : `${reason}.`;
}

function settle(
  verb: keyof typeof VOICE,
  error: unknown,
  results: MigrationResult[] | undefined,
  target?: MigrationTarget,
): MigrationResult[] {
  if (error !== undefined) {
    const voice = VOICE[verb];
    const failed = results?.find((result) => result.status === "Error");
    const applied = results?.filter((result) => result.status === "Success").map((result) => result.migrationName);
    const problem = failed ? voice.failed(failed.migrationName) : voice.fallback;
    // D1 applies migrations non-transactionally, so name what stuck before the failure.
    const stuck = applied?.length
      ? `Applied before the failure: ${applied.map((name) => `"${name}"`).join(", ")}.`
      : "";
    throw new InternalError(
      {
        message: `${problem}${on(target)}. ${reasonOf(error)}`,
        detail: [where(target), stuck].filter(Boolean).join(" "),
        action: voice.action,
      },
      { cause: error },
    );
  }
  return results ?? [];
}
