// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { CamelCasePlugin } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { ValidationError } from "../error/pithyError";
import { declareRetainedDown, retainedTablesOf, retainedTablesOfDown } from "./retainedDeclaration";

/**
 * **A retained table holds rows that exist nowhere else (#588).**
 *
 * A migration's `down` is the tested inverse of its `up`, and for schema that is exactly right. For a
 * vault it is a `drop table` on the only copy of a credential Google issued. `0100_secrets_0001_init` is
 * the whole history of the secrets database, so one `pithy migrate --rollback` — which steps back one
 * migration in every composed database — emptied it in place, on staging, with nothing said first.
 *
 * So a capability **declares** a table retained, beside the migrations that create it
 * (`DatabaseSpec.retained`), and the declaration is recorded on those migrations' own `down` functions
 * (`./retainedDeclaration`) — by `defineCapability`, and again by `createMigrationRegistry` for a set that
 * carries it. The refusal is on the operation that runs a `down`, not on a list of commands:
 * {@link guardRetained} wraps every `down` a provider yields, and the runner applies it to every provider
 * it is handed.
 *
 * ## What is TRUE
 *
 * **No `down` runs against a database while a table declared retained in that database holds rows**,
 * beyond what the caller's {@link RetainedBudget} agreed to destroy. A count, not a boolean, so a flag
 * somebody has in their shell history for another database does not also authorize this one — and one
 * budget spent across a whole run, so an agreement to five rows cannot destroy five in every database.
 *
 * The budget is the operator's number and nothing else. The CLI's preflight also demands it *equal* the
 * rows in scope; this floor demands only that no more are spent, and it is deliberately not handed the
 * preflight's count — a guard fed the answer by the check above it is not a second guard.
 *
 * ## Its reach, stated so it can be checked
 *
 * - **Database-wide, deliberately.** A `down` cannot be inspected for which tables it drops without running
 *   it, so any `down` against a database holding retained rows is refused — including a migration of a
 *   different capability that never touches them. Over-refusing costs an override; under-refusing costs a
 *   vault.
 * - **Every `down` through `runner.ts`** — `rollbackMigration`, `resetMigrations`, `dropMigrations` — whose
 *   function was declared: the registry's providers, the fan-out's merged ones, and a provider written by
 *   hand, so long as it yields the capability's own migration objects (or spreads of them).
 * - **Not seen:** a Kysely `Migrator` constructed outside `runner.ts`; a `down` whose capability was never
 *   constructed in this process and whose set never passed through the registry; a `down` re-wrapped in a
 *   new function by anything but {@link beforeEachDown}; and a table no capability declares — a capability
 *   removed from the config takes its declaration with it.
 */

/** The snake_case the `CamelCasePlugin` writes, read from the plugin itself so there is one definition. */
class TableNames extends CamelCasePlugin {
  sqlName(key: string): string {
    return this.snakeCase(key);
  }
}

const NAMES = new TableNames();

/** The SQL name of a declared table key — `pithySecretsSystemSecrets` → `pithy_secrets_system_secrets`. */
export function retainedTableName(key: string): string {
  return NAMES.sqlName(key);
}

/** One retained table that holds rows, on the binding it was counted through. */
export interface RetainedRows {
  /** The D1 binding the table lives behind — the name an adopter recognizes. */
  binding: string;
  /** The SQL table name. */
  table: string;
  /** How many rows it holds. Always positive: an empty or absent table is not at risk. */
  rows: number;
}

/** The SQL names of the retained tables a provider's migrations declare. Reads no database. */
export async function retainedTableNames(provider: MigrationProvider): Promise<string[]> {
  return retainedTablesOf(await provider.getMigrations()).map(retainedTableName);
}

/**
 * Count the rows in every retained table these migrations declare that is present in the database.
 * Read-only. Returns only the tables holding rows, so an empty result means nothing retained is at risk.
 */
export async function countRetainedRows(
  database: D1Database,
  migrations: Readonly<Record<string, Migration>>,
  binding: string,
): Promise<RetainedRows[]> {
  const counted: RetainedRows[] = [];
  for (const key of retainedTablesOf(migrations)) {
    const table = retainedTableName(key);
    const present = await database
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .bind(table)
      .first<{ name: string }>();
    if (!present) continue;
    // The name came from a capability's declaration and through the plugin's own snake-casing, never from
    // input, and it has just been matched against `sqlite_master` — quoting it is belt, not braces.
    const row = await database.prepare(`select count(*) as n from "${table}"`).first<{ n: number }>();
    const rows = row?.n ?? 0;
    if (rows > 0) counted.push({ binding, table, rows });
  }
  return counted;
}

/**
 * The refusals raised ahead of a `down`. A `Migrator` catches whatever a `down` throws and hands it back as
 * a result, and the runner turns that into "Couldn't roll back" with a remedy to fix the migration — which
 * is wrong for a refusal, where no migration is broken. So the runner asks {@link isDownRefusal} and
 * rethrows one unchanged.
 */
const REFUSALS = new WeakSet<object>();

/**
 * Mark an error as a refusal to run a `down`, so it reaches the operator as itself rather than as a failed
 * migration. For a guard written outside this module — the CLI's shared-database floor is one.
 */
export function downRefusal<E extends ValidationError>(error: E): E {
  REFUSALS.add(error);
  return error;
}

/** Whether `error` refused a `down` before it ran — as opposed to a migration that failed. */
export function isDownRefusal(error: unknown): error is ValidationError {
  return typeof error === "object" && error !== null && REFUSALS.has(error);
}

/** `5 rows`, `1 row`. */
function rowsLabel(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

/**
 * What a refusal was raised ahead of, as the sentence ends: `Refused before <this>.` A `down` for the
 * runner and the migration fan-out; a database deletion for a teardown that removes the database whole
 * (#591), where "any down ran" would name an operation that was never going to happen.
 */
export type RefusedBefore = "any down against them ran" | "anything was deleted";

/**
 * The refusal, in one wording for every place that raises it — the fan-out's preflight, which names every
 * database before any of them moves, {@link guardRetained}, which is the floor under it, and a teardown
 * that deletes a database holding retained tables (`pithy secrets deprovision`, #591).
 *
 * `consent` is what the caller passed. The action always prints the number that would work, because that
 * number is the one fact the operator has to read before typing it.
 */
export function retainedRefusal(
  atRisk: readonly RetainedRows[],
  consent: number | undefined,
  before: RefusedBefore = "any down against them ran",
): ValidationError {
  return downRefusal(refusalFor(atRisk, consent, before));
}

/**
 * **The preflight: refuse unless the operator counted exactly the retained rows in scope.**
 *
 * Absent a count, only an empty scope passes; given one, only the same number does — a count that is too
 * high is a count of something else, and agreeing to it would let a stale number from shell history through
 * the day the rows it described are joined by more. Call it with every database the operation will touch,
 * counted before the first of them moves, so the refusal names them all with nothing changed.
 *
 * The floor under it is {@link RetainedBudget}, fed the operator's number and never this function's
 * count.
 */
export function assertRetainedAgreed(
  atRisk: readonly RetainedRows[],
  consent: number | undefined,
  before: RefusedBefore = "any down against them ran",
): void {
  const total = atRisk.reduce((sum, entry) => sum + entry.rows, 0);
  const agreed = consent === undefined ? total === 0 : consent === total;
  if (!agreed) throw retainedRefusal(atRisk, consent, before);
}

function refusalFor(
  atRisk: readonly RetainedRows[],
  consent: number | undefined,
  before: RefusedBefore,
): ValidationError {
  const total = atRisk.reduce((sum, entry) => sum + entry.rows, 0);
  const named = atRisk.map((entry) => `${entry.table} on ${entry.binding} (${rowsLabel(entry.rows)})`).join(", ");
  const mismatch =
    consent === undefined ? "" : `--destroy-retained ${consent} does not match the ${rowsLabel(total)} at risk. `;
  if (total === 0) {
    return new ValidationError({
      message: `${mismatch}Nothing retained is at risk. Refused before ${before === "anything was deleted" ? before : "any down ran"}.`,
      action: "Run it again without --destroy-retained.",
    });
  }
  return new ValidationError({
    message: `${mismatch}Retained ${rowsLabel(total)} would be dropped: ${named}. Refused before ${before}.`,
    action: `They exist nowhere else. Back them up, or pass --destroy-retained ${total} to drop them.`,
    detail:
      "A retained table is declared by its capability. Any down against its database, and any deletion of the database, is refused while it holds rows.",
  });
}

/**
 * **How many retained rows a run has agreed to destroy, spent as each database is reached.**
 *
 * One per run, shared by every database in it. Absent an agreement it holds nothing, so any retained row
 * refuses. A database whose rows exceed what is left is refused whole — nothing is spent on a refusal.
 */
export class RetainedBudget {
  /** What the caller agreed to, as they typed it — the number a refusal quotes back. */
  readonly agreed: number | undefined;
  #remaining: number;

  constructor(agreed: number | undefined) {
    this.agreed = agreed;
    this.#remaining = agreed ?? 0;
  }

  /** Spend `rows` if the budget covers them. False, and nothing spent, when it does not. */
  spend(rows: number): boolean {
    if (rows > this.#remaining) return false;
    this.#remaining -= rows;
    return true;
  }
}

/**
 * Wrap a provider so no `down` it yields runs while the database holds retained rows the budget does not
 * cover. The check runs once, at the first `down`, and its answer stands for the rest of the run: a reset
 * whose first `down` dropped the vault must not refuse its second for finding it empty.
 *
 * Counted at the `down`, not before: a row written after somebody else counted is a row this refuses.
 */
export function guardRetained(
  provider: MigrationProvider,
  database: D1Database,
  options: { binding: string; budget: RetainedBudget },
): MigrationProvider {
  let cleared: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    const atRisk = await countRetainedRows(database, await provider.getMigrations(), options.binding);
    const total = atRisk.reduce((sum, entry) => sum + entry.rows, 0);
    if (!options.budget.spend(total)) throw retainedRefusal(atRisk, options.budget.agreed);
  };
  return beforeEachDown(provider, async () => {
    cleared ??= check();
    await cleared;
  });
}

/**
 * Wrap a provider so `before` runs ahead of every `down` it yields — and a throw from `before` means the
 * `down` never runs. Ups pass through untouched.
 *
 * **Each new `down` keeps the declaration of the one it wraps.** That is the reason this is the one way to
 * wrap a provider's downs: a hand-rolled wrapper is a new function the declaration has never heard of, and
 * {@link guardRetained} handed it would find nothing declared and let every `down` through.
 */
export function beforeEachDown(provider: MigrationProvider, before: () => Promise<void>): MigrationProvider {
  const wrapped: MigrationProvider = {
    getMigrations: async (): Promise<Record<string, Migration>> => {
      const migrations = await provider.getMigrations();
      return Object.fromEntries(
        Object.entries(migrations).map(([name, migration]) => {
          const down = migration.down;
          if (!down) return [name, migration];
          const guardedDown = async (db: Parameters<typeof down>[0]): Promise<void> => {
            await before();
            await down(db);
          };
          declareRetainedDown(guardedDown, retainedTablesOfDown(down));
          const guarded: Migration = { up: migration.up, down: guardedDown };
          return [name, guarded];
        }),
      );
    },
  };
  return wrapped;
}
