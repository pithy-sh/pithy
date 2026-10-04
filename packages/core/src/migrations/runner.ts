// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Kysely, sql } from "kysely";
import { type MigrationProvider, type MigrationResult, Migrator, NO_MIGRATIONS } from "kysely/migration";
import { causeMessage } from "../error/cause";
import { InternalError, ValidationError } from "../error/pithyError";
import { batchedProvider } from "./batch";
import { appliedMigrationChain, MIGRATION_LOCK_TABLE, MIGRATION_TABLE, migrationKysely } from "./bookkeeping";
import { forgetMigrationGroups, generatedMigrationGroup, readGroupPosition, recordMigrationGroup } from "./groups";
import { guardRetained, isDownRefusal, RetainedBudget } from "./retained";

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
 * One runner at a time per database. Kysely's SQLite adapter reports no transactional DDL and its
 * migration lock is a no-op, so concurrent runs can interleave. That fits the deployment model —
 * migrations run from `pithy migrate` (CLI/CI), not inside request handlers — but it is an
 * assumption, not a guard. On failure the thrown `InternalError` names the failed key, the database
 * it was running against, and **what the runtime actually said**, all in `message`; `detail` keeps
 * the throw-site half — the database name behind the binding, and the migrations applied before the
 * failure, since those stay applied.
 *
 * **Each migration body is one `d1.batch()` — see `./batch`, which is where the failure semantics
 * are argued.** The short version: a migration is now all-or-nothing where it used to be able to
 * half-apply, and nothing across a migration boundary changed, because the ledger names migrations
 * and a partial chain has to stay representable in it.
 *
 * **Every run belongs to a group, and a reversal names one — see `./groups` (#694).** A forward run
 * records the group it applied each migration under, in a table beside the ledger;
 * {@link reverseMigrationGroup} reverses one group's portion of one database, in reverse chain order and
 * nothing outside it. {@link rollbackMigration} is still the single step underneath, for a caller holding
 * one migration rather than a release — it is not what `pithy migrate --rollback` runs any more.
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
function migrator(
  database: D1Database,
  provider: MigrationProvider,
  target: MigrationTarget | undefined,
  consent: RetainedConsent | undefined,
): Migrator {
  return new Migrator({
    db: migrationKysely(database),
    // Each migration body applies in one `d1.batch()`; the ledger row stays on the ordinary path,
    // so nothing batches across a migration boundary. See `./batch`. Every `down` is guarded before it
    // is batched: no reversal runs while a retained table in this database holds rows (#588).
    provider: batchedProvider(guardRetained(provider, database, guardOptions(target, consent)), database),
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
  /** The D1 binding, as `wrangler.jsonc` declares it — the name an adopter recognizes. */
  binding: string;
  /** The database name: a capability's `databases` key. Throw-site context, not the adopter's handle. */
  database: string;
}

/**
 * What a caller that reverses migrations says about retained rows (#588) — see `./retained`.
 *
 * Optional, and absent is the safe answer: a caller that says nothing has counted nothing, so any `down`
 * against a database holding retained rows is refused.
 */
export interface RetainedConsent {
  /**
   * The retained rows the caller agreed to destroy. Pass one budget to every database in a run, so one
   * agreement is spent once; a caller reversing a single database builds its own. Absent means none.
   */
  budget?: RetainedBudget;
}

/** The guard's options: the binding its refusal names, and the budget the caller agreed to. */
function guardOptions(
  target: MigrationTarget | undefined,
  consent: RetainedConsent | undefined,
): { binding: string; budget: RetainedBudget } {
  return { binding: target?.binding ?? "this database", budget: consent?.budget ?? new RetainedBudget(undefined) };
}

/**
 * What a forward run records about itself (#694) — see `./groups`.
 *
 * Optional, and absent still records: a run with no group named is a group of its own, stamped with the
 * moment it ran. There is always a group, so a rollback never has to fall back to counting migrations.
 */
export interface RunGroupOptions {
  /**
   * The group every migration this run applies is recorded under. Absent, a generated ISO-8601 timestamp
   * is used — per run, by construction. A caller spanning several databases passes **one** value to all
   * of them, so one run is one group however many databases it touches.
   */
  group?: string;
}

/**
 * Run every pending migration to latest, recording the run's group against each one. An empty provider
 * resolves to `[]` and records nothing.
 *
 * **The group is written from what Kysely hands back, and before the failure is raised.** A run that
 * half-applies is retried with the key it already has, so the migrations that stuck have to be in the
 * group — otherwise the retry's group would sit on top of an ungrouped migration, and reversing the
 * retry would leave half a release applied with nothing recording it.
 */
export async function runMigrations(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
  options?: RunGroupOptions,
): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider, target, undefined).migrateToLatest();
  const applied = (results ?? [])
    .filter((result) => result.direction === "Up" && result.status === "Success")
    .map((result) => result.migrationName);
  try {
    await recordMigrationGroup(database, {
      group: options?.group ?? generatedMigrationGroup(),
      migrations: applied,
    });
  } catch (cause) {
    // A migration failure is the operator's first problem and wins the throw; `settle` raises it below.
    // With the run otherwise clean, a ledger that records a migration no group claims is its own fault.
    if (error === undefined) {
      throw new InternalError(
        {
          message: `Applied ${applied.length === 1 ? "a migration" : `${applied.length} migrations`}${on(target)}, then couldn't record the group.`,
          detail: `${where(target)} ${reasonOf(cause)}`,
          // Never "run pithy migrate again to record the group": the second run has nothing pending, so it
          // records nothing and prints `Nothing to migrate.` while the group stays lost. The honest fact is
          // what these migrations can no longer be — the group they were applied under is gone (#694).
          action:
            "Check the database is writable. A second pithy migrate records nothing for them, so they cannot be reversed by group.",
        },
        { cause },
      );
    }
  }
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
 * reads an unrecognized applied migration as a corrupted chain and applies nothing (#282).
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

/**
 * Step this database's latest applied migration back — **one** step, in **one** database.
 *
 * It is no longer what `pithy migrate --rollback` runs: a rollback names a group and reverses that
 * group's portion of each database ({@link reverseMigrationGroup}, #694). What this is, is the single
 * step underneath — the primitive every capability's "its `down` is the inverse of its `up`" suite
 * reverses one migration with, and the honest answer for a caller holding one migration rather than a
 * release.
 *
 * It forgets the reversed migration's group row, so the group bookkeeping follows the ledger whichever
 * way a migration came down. Refused while a retained table here holds rows the caller has not counted in
 * `consent` (#588).
 */
export async function rollbackMigration(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
  consent?: RetainedConsent,
): Promise<MigrationResult[]> {
  const { error, results } = await migrator(database, provider, target, consent).migrateDown();
  await forgetReversed(database, results);
  return settle("rollback", error, results, target);
}

/** What one database reverses of a group: the group, and its migrations newest first. */
export interface MigrationGroupStep {
  /** The group being reversed — what the caller passed to `--group`. */
  group: string;
  /**
   * This database's portion of it, in the order it comes down: newest first. The caller reads it from
   * `readGroupPosition`, which is also what proves the group is the top of this database's chain. It says
   * **whether** there is anything to reverse here; what comes down is read from the ledger again below, so
   * a step that named a migration from the group underneath could not reverse it on the caller's word.
   */
  migrations: readonly string[];
}

/**
 * **Reverse one group's portion of one database — the operation behind `pithy migrate --rollback
 * --group` (#694).**
 *
 * Kysely steps down from the tip, so this is `migrateDown()` once per migration in the group, in reverse
 * chain order, and **nothing outside it**. Both halves of that are read from the ledger here, not taken on
 * the caller's word: the group has to be the ledger's own tail before the first `down`, and what each step
 * brings down has to be one of the migrations that read said the group holds — anything else is an
 * internal fault and throws rather than carrying on. **And a migration with no `down` stops the group**:
 * Kysely reports one as `NotExecuted` and leaves it applied, so counting it as reversed is how a group
 * reported itself fully rolled back with half of it still in the database. The caller's pre-flight is what
 * makes a group reverse completely or not at all across databases; this is the floor under it.
 *
 * **One migrator for the whole group**, so the retained guard clears once and the caller's budget is spent
 * once across every `down` it covers (#588). Each migration's group row is forgotten as it comes down —
 * before the step's failure is raised — so a group reversal that dies partway can be re-run under the
 * same group and reverses what is left.
 */
export async function reverseMigrationGroup(
  database: D1Database,
  provider: MigrationProvider,
  step: MigrationGroupStep,
  target?: MigrationTarget,
  consent?: RetainedConsent,
): Promise<MigrationResult[]> {
  if (step.migrations.length === 0) return [];
  // Asked of the ledger before the first `down`, so the ordinary ways to get this wrong — another group
  // applied over this one, or a migration applied under no group at all — are refused rather than
  // diagnosed afterwards, from under a `down` that has already run.
  const position = await readGroupPosition(database, step.group);
  if (position.state !== "top") {
    throw new InternalError({
      message: `Group "${step.group}" is not the top of ${target?.binding ?? "this database"}'s chain.`,
      detail: `${where(target)} ${position.state === "absent" ? "It records nothing under that group." : `Applied over it: ${overIt(position.above, position.ungrouped)}.`}`,
      action: "Run pithy doctor to see where each database stands.",
    });
  }
  // What comes down is what the ledger says this group holds, never the caller's list: a step naming a
  // migration the group does not hold would otherwise be reversed on the caller's word.
  const remaining = new Set(position.migrations);
  const runner = migrator(database, provider, target, consent);
  const reversed: MigrationResult[] = [];
  while (remaining.size > 0) {
    const { error, results } = await runner.migrateDown();
    await forgetReversed(database, results);
    const settled = settle("rollback", error, results, target);
    if (settled.length === 0) break;
    for (const result of settled) {
      // **A migration with no `down` is a refusal, not a reversal.** Kysely's `#migrateDown` runs the body
      // and deletes the ledger row only `if (migration.down)`, so one without it comes back `NotExecuted`
      // — no error, row intact — and `./batch` preserves that shape deliberately. Counted as reversed, the
      // group reported itself fully rolled back while part of it was still applied and still carried its
      // group rows; and when the `down`-less migration was the group's newest, the next pass got the same
      // tip back and the throw below blamed the chain's order for a missing `down`. So it stops here, in
      // the one wording that names the cause, before the rest of the group comes down around it.
      if (result.status !== "Success") {
        throw new ValidationError({
          message: `Migration "${result.migrationName}" has no down, so group "${step.group}" cannot be reversed${on(target)}.`,
          action: `Give ${result.migrationName} a down, then reverse the group again.`,
          // What already came down stays down, and the operator needs it by name to know where they are —
          // the same fact `settle` reports for a forward run that failed partway.
          detail: [
            where(target),
            reversed.length === 0
              ? "Nothing was reversed. A group reverses completely or not at all."
              : `Reversed before the refusal: ${reversed.map((entry) => `"${entry.migrationName}"`).join(", ")}. The rest of the group is still applied.`,
          ]
            .filter(Boolean)
            .join(" "),
        });
      }
      if (!remaining.delete(result.migrationName)) {
        throw new InternalError({
          message: `Reversing group "${step.group}"${on(target)} would have reversed "${result.migrationName}", which is not in it.`,
          detail: `${where(target)} The group was not the top of this database's chain. Kysely steps down from the tip, so only the newest group can be reversed.`,
          action: "Run pithy doctor to see where each database stands.",
        });
      }
      reversed.push(result);
    }
  }
  return reversed;
}

/** Forget the group rows of whatever actually came down, whether or not the step then failed. */
async function forgetReversed(database: D1Database, results: MigrationResult[] | undefined): Promise<void> {
  const names = (results ?? [])
    .filter((result) => result.direction === "Down" && result.status === "Success")
    .map((result) => result.migrationName);
  await forgetMigrationGroups(database, names);
}

/**
 * Fully reset one database's schema: every applied migration's `down` runs, in one pass, in reverse
 * chronological order — Kysely's `NO_MIGRATIONS` target, not just the latest — then every migration's
 * `up` reapplies from empty. The seam behind `pithy seed --redo`'s destructive rebuild: because the
 * schema comes back empty, the ordinary non-destructive seed writes (`INSERT OR IGNORE`, KV
 * skip-if-exists) simply work afterward — there is no per-row identity problem to solve. An empty
 * ledger rolls back nothing; an empty provider reapplies nothing. Refused, before the first `down`, while a
 * retained table here holds rows the caller has not counted in `consent` (#588).
 *
 * **It leaves the group bookkeeping exactly as it was (#694).** The table is not a migration, so the `down`
 * pass cannot remove it, and rewriting the rows would restamp somebody's release as having happened during
 * a `seed --redo`. Every group row still describes a migration this reset reapplied.
 *
 * **What it does not do is record a group for the rest.** A reset reapplies everything *declared*, which
 * includes migrations that were pending when it started, and those come back applied under no group — this
 * takes no group and invents none. Such a migration sits over the groups below it, so a `--rollback
 * --group` of one of them is refused by name (`./groups`, `readGroupPosition`) rather than reversing a
 * migration nobody recorded.
 */
export async function resetMigrations(
  database: D1Database,
  provider: MigrationProvider,
  target?: MigrationTarget,
  consent?: RetainedConsent,
): Promise<MigrationResult[]> {
  const runner = migrator(database, provider, target, consent);
  const down = await runner.migrateTo(NO_MIGRATIONS);
  const downResults = settle("resetDown", down.error, down.results, target);
  const up = await runner.migrateToLatest();
  const upResults = settle("resetUp", up.error, up.results, target);
  return [...downResults, ...upResults];
}

/**
 * The applied migration names recorded in the ledger — empty when the ledger table doesn't exist yet. The
 * set half of `appliedMigrationChain`, which is the one read of the ledger: order matters to a group
 * rollback and not at all to a membership test, and two reads of one table would drift.
 */
async function appliedMigrationNames(db: Kysely<unknown>): Promise<Set<string>> {
  return new Set(await appliedMigrationChain(db));
}

/**
 * What a drop reverses, and the database it reverses it in.
 *
 * Two providers because they answer two questions. `reverse` is the part being removed — one capability's
 * migrations. `database` is every migration composed into that D1, and it is what the retained guard counts:
 * a table is retained in a *database*, and the capability being dropped is the one least likely to declare
 * the vault it shares a database with (#588). Handed only the part, the guard counted what the part declared
 * — nothing — while the vault beside it held rows.
 */
export interface DropSelection {
  /** Every migration composed into this database — the set whose retained declarations are counted. */
  database: MigrationProvider;
  /** The migrations to reverse: a part of `database`, by composed name. */
  reverse: MigrationProvider;
}

/**
 * Surgically drop **one capability's** migrations: run each of `drop.reverse`'s `down` functions in
 * reverse order and delete only those ledger rows, leaving every other capability's tables and
 * bookkeeping untouched. The seam behind `pithy remove --drop`. Kysely's stepwise `Migrator` refuses a
 * provider that doesn't span the whole ledger (it reads a foreign row as corrupt state), so a
 * per-capability drop can't go through it — this reverses the capability's own migrations directly.
 * Only migrations recorded in the ledger are reversed; an absent ledger drops nothing. Refused, before the
 * first `down`, while a retained table **anywhere in `drop.database`** holds rows the caller has not counted
 * in `consent` (#588). A name `drop.reverse` carries that `drop.database` does not is an internal fault: the
 * guard would not have counted the database the `down` runs in.
 */
export async function dropMigrations(
  database: D1Database,
  drop: DropSelection,
  target?: MigrationTarget,
  consent?: RetainedConsent,
): Promise<MigrationResult[]> {
  const db = migrationKysely(database);
  // Batched here too: `down` pays the same per-statement cost `up` does, and a drop is all DDL. Guarded
  // first, exactly as the `Migrator` path is (#588) — over the whole database's set, so the count is too.
  const guarded = guardRetained(drop.database, database, guardOptions(target, consent));
  const migrations = await batchedProvider(guarded, database).getMigrations();
  const reversing = Object.keys(await drop.reverse.getMigrations());
  const stray = reversing.filter((name) => !(name in migrations));
  if (stray.length > 0) {
    throw new InternalError({
      message: `Couldn't drop ${stray.map((name) => `"${name}"`).join(", ")}${on(target)}. The database's migrations do not carry it.`,
      detail: `${where(target)} A drop counts retained rows over the database's whole set, so every migration it reverses must be in it.`,
      action: "Build the drop from the database's composed migrations. Nothing was dropped.",
    });
  }
  const applied = await appliedMigrationNames(db);

  const results: MigrationResult[] = [];
  // Reverse application order: drop the newest of the capability's migrations first.
  for (const name of reversing.sort().reverse()) {
    if (!applied.has(name)) continue;
    // No `down` — the migration can't be reversed, so leave both its table and its ledger row in place
    // (deleting the row would desync the ledger from the schema). Every Pithy migration ships a `down`.
    const down = migrations[name]?.down;
    if (!down) continue;
    try {
      await down(db);
      await sql`delete from ${sql.table(MIGRATION_TABLE)} where name = ${name}`.execute(db);
      // The group bookkeeping follows the ledger row it describes: a dropped migration is not applied,
      // so nothing may go on recording which run applied it.
      await forgetMigrationGroups(database, [name]);
      results.push({ migrationName: name, direction: "Down", status: "Success" });
    } catch (error) {
      // A refusal is not a failed drop: nothing is broken, and "fix the migration's down" would be a lie.
      if (isDownRefusal(error)) throw error;
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
    // Still not a bare "run --rollback again" — that command reverses nothing now, and before #694 it
    // stepped a second migration back in every database that had already moved (#588). Re-running the
    // *same group* is the safe retry: each migration's group row is forgotten as it comes down, so a
    // second pass reverses what is left and nothing else. The group is on the command, not here.
    action: "Fix the migration's down. Run pithy doctor to see where each database stands.",
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

/**
 * What sits over a buried group, groups and ungrouped migrations alike, newest first.
 *
 * An ungrouped migration is named with its state, because the two are different problems: another group is
 * something to reverse first, while a migration no group claims cannot be reversed by group at all.
 */
function overIt(above: readonly string[], ungrouped: readonly string[]): string {
  return [...above, ...ungrouped.map((name) => `${name} (ungrouped)`)].join(", ");
}

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
 * drop is what this whole path is being fixed for. Color codes come off, because they are formatting
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
    // A guard refused before a `down` ran. It already names what it protected and the way past it, and
    // nothing about it is a migration to fix — so it reaches the operator as itself (#588).
    if (isDownRefusal(error)) throw error;
    const voice = VOICE[verb];
    const failed = results?.find((result) => result.status === "Error");
    const applied = results?.filter((result) => result.status === "Success").map((result) => result.migrationName);
    const problem = failed ? voice.failed(failed.migrationName) : voice.fallback;
    // The chain is applied one migration at a time, so name what stuck before the failure. The
    // failed migration itself is not among them: its body was one batch, and the batch rolled back.
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
