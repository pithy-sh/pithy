// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Generated, Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { chunkByBoundParameters, chunkRowsByBoundParameters } from "../data/boundParameters";
import { SQLiteDate } from "../data/codecs";
import { appliedMigrationChain, MIGRATION_GROUP_TABLE, migrationKysely } from "./bookkeeping";

/**
 * **Which run applied each migration — the group a rollback names (#694).**
 *
 * `pithy migrate --rollback` used to step back one migration in every database the environment binds, and
 * nothing recorded what a single run had applied. So reversing a deploy that moved three migrations was
 * three invocations and the count came from outside the tool — a human's memory, or a CI log read under
 * pressure. Every run belongs to a group now: the caller's own `--group <value>`, or a generated ISO-8601
 * timestamp, recorded here against every migration the run applies, in every database it touches.
 *
 * **It cannot live in the ledger.** `pithy_migrations` is Kysely's own table, renamed off its default
 * (`./bookkeeping`); Kysely creates it and its insert sets `name` and `timestamp` only. So the group sits
 * in a table *beside* it, written by the runner from the `MigrationResult[]` Kysely hands back — the same
 * placement, and the same reasoning, as `pithy_migrations_owner`: it is not a migration, so no capability
 * ships it, `--rollback` cannot step it back, and `pithy seed --redo`'s full reset cannot wipe it. What a
 * reversal removes is the reversed migrations' own rows, which is bookkeeping catching up with the ledger.
 *
 * **The rows say which run; the ledger says which order.** Every applied migration is recorded here as it
 * applies and forgotten as it is reversed, so these rows are the membership. Where a group *sits* is a
 * question about the ledger, though, because the ledger is what Kysely steps down from — so {@link
 * readGroupPosition} reads both (`appliedMigrationChain`) and compares the group against the chain's tail.
 * Reading the group table alone would answer from the order this table happened to be written in, and the
 * two differ in exactly the cases that matter: a migration applied with no group row at all.
 *
 * **What it cannot see, it names.** A migration applied before this table existed carries no row, and so
 * does one a `seed --redo` reset reapplied or one whose group write failed. Such a migration over a group
 * buries it — reversing the group would reverse a migration nobody recorded — and the position says so by
 * name rather than calling the group reversible. Reading is cheap and additive: one group row per applied
 * migration, and the table is created on the first run that applies anything.
 */

/** One applied migration and the run that applied it. The three columns are the whole table. */
export const MigrationGroupRecord = z
  .object({
    groupKey: z
      .string()
      .describe(
        "The group this migration was applied under — the caller's `--group` value, or the generated ISO-8601 timestamp of the run. Not `group`: that is SQL's own word, and an operator reading this table by hand should not have to quote a column.",
      ),
    migration: z.string().describe("The composed migration name, exactly as the ledger records it."),
    appliedAt: SQLiteDate.describe("When this migration was applied — the moment the run recorded it."),
  })
  .describe("One applied migration's membership of a migration group, recorded beside the ledger.");
export type MigrationGroupRecord = z.output<typeof MigrationGroupRecord>;

/**
 * The group table as Kysely sees it: the schema's `z.input` (SQLite row) side — derived, never a
 * hand-written row interface — plus the autoincrementing key that makes insertion order readable.
 * `CamelCasePlugin` passes the already-snake_case table name through unchanged and maps every column.
 */
interface GroupDatabase {
  pithy_migrations_groups: z.input<typeof MigrationGroupRecord> & { id: Generated<number> };
}

/** One group as it stands in one database: what it applied here, and when it last did. */
export interface MigrationGroup {
  /** The group's value — what `--rollback --group` takes back. */
  group: string;
  /**
   * When this group last applied something here. A group extended by a retry carries the later moment,
   * because that is the one that decides which group is newest.
   */
  appliedAt: Date;
  /** The migrations this group applied in this database, in the order they were applied. */
  migrations: string[];
}

/**
 * Where a group sits in one database's chain — the question a rollback asks before it reverses anything.
 *
 * Three states, kept apart because they are three different answers. `absent` is *this database applied
 * nothing under that group*, which for a group spanning two databases is ordinary and not a refusal.
 * `buried` is the refusal: Kysely steps down from the tip, so reversing it would mean reversing the
 * migrations over it, from groups nobody named.
 */
export type GroupPosition =
  | { state: "absent" }
  | {
      /** The group's migrations are the top of this database's chain. */
      state: "top";
      /** Them, in the order they will be reversed — newest first. */
      migrations: string[];
    }
  | {
      /** Something else sits over the group, or inside it. */
      state: "buried";
      /**
       * The groups in the way, newest first: applied over its newest migration, or inside it by a run that
       * came between two of its own. A group extended after another ran names that one.
       */
      above: string[];
      /**
       * The migrations in the way that no group claims, newest first — an older kit's, a reset's re-apply, or
       * a run whose group write failed. They bury the group as surely as another group does, and nothing can
       * be reversed by group while one of them is at the tip.
       */
      ungrouped: string[];
      /**
       * The group whose own migrations *are* the contiguous tip here, when there is one — the only group a
       * refusal may name as reversible. Absent when the tip is interleaved or ungrouped, which is the state
       * where naming anything would print a command that refuses in its turn.
       */
      top?: string;
    };

/** What {@link recordMigrationGroup} writes: the group, what it applied, and when. */
export interface RecordGroupOptions {
  /** The group every migration in this call was applied under. */
  group: string;
  /** The migrations applied, in application order. Empty writes nothing at all. */
  migrations: readonly string[];
  /** When they applied. Defaults to now; passed explicitly by tests and by a caller that stamps a run. */
  at?: Date;
}

/**
 * The group a run with no `--group` belongs to: an **ISO-8601 timestamp**, `2026-10-03T19:52:47.611Z`.
 *
 * A timestamp rather than a date, because one run is one group. Date-only would silently merge two
 * unrelated runs on a busy day into one group, and reversing it would then undo more than the caller did.
 * The precision costs nothing, it sorts lexicographically into chronological order, and it tells an
 * operator *when* without their having named anything.
 */
export function generatedMigrationGroup(now: Date = new Date()): string {
  return now.toISOString();
}

/** Whether the group table has been created yet — a plain `sqlite_master` select, which D1 permits. */
async function groupTableExists(db: Kysely<GroupDatabase>): Promise<boolean> {
  const { rows } = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name = ${MIGRATION_GROUP_TABLE}`.execute(db);
  return rows.length > 0;
}

/** Every row, in the order it was written — which is the order the migrations applied. */
async function groupRows(db: Kysely<GroupDatabase>): Promise<MigrationGroupRecord[]> {
  if (!(await groupTableExists(db))) return [];
  const rows = await db
    .selectFrom("pithy_migrations_groups")
    .select(["groupKey", "migration", "appliedAt"])
    .orderBy("id")
    .execute();
  return rows.map((row) => MigrationGroupRecord.parse(row));
}

/**
 * How many parameters one group row binds — derived from the schema, so a fourth column re-derives the
 * chunk size instead of silently taking the insert back over D1's cap.
 */
const GROUP_ROW_COLUMNS = Object.keys(MigrationGroupRecord.shape).length;

/**
 * Record a group against the migrations a run just applied, creating the table on demand. Idempotent in
 * the only sense that matters: a migration applies once, so a name arrives here once — and a second call
 * under the same group **extends** it, which is the retry case a release whose migrate half-failed needs.
 */
export async function recordMigrationGroup(database: D1Database, options: RecordGroupOptions): Promise<void> {
  if (options.migrations.length === 0) return;
  const db = migrationKysely<GroupDatabase>(database);
  await db.schema
    .createTable(MIGRATION_GROUP_TABLE)
    .ifNotExists()
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("groupKey", "text", (column) => column.notNull())
    .addColumn("migration", "text", (column) => column.notNull())
    .addColumn("appliedAt", "integer", (column) => column.notNull())
    .execute();

  const appliedAt = options.at ?? new Date();
  const rows = options.migrations.map((migration) =>
    MigrationGroupRecord.encode({ groupKey: options.group, migration, appliedAt }),
  );
  // One insert per chunk, because an insert binds one parameter per column per row and D1 takes 100 in a
  // statement: one multi-row insert broke at 34 migrations, which is a chain a fresh environment applies in
  // one `pithy provision` — and it broke *after* the schema was promoted, leaving the release ungrouped.
  for (const chunk of chunkRowsByBoundParameters(rows, GROUP_ROW_COLUMNS)) {
    await db.insertInto("pithy_migrations_groups").values(chunk).execute();
  }
}

/**
 * Every group this database records, oldest first by when each last applied something — and so the last
 * entry is the newest group, which is what a rollback with no `--group` names. Empty for a database
 * nothing has grouped, and reading creates nothing.
 */
export async function readMigrationGroups(database: D1Database): Promise<MigrationGroup[]> {
  const rows = await groupRows(migrationKysely<GroupDatabase>(database));
  const byGroup = new Map<string, MigrationGroup & { order: number }>();
  for (const [index, row] of rows.entries()) {
    const existing = byGroup.get(row.groupKey);
    if (existing) {
      existing.migrations.push(row.migration);
      existing.appliedAt = row.appliedAt > existing.appliedAt ? row.appliedAt : existing.appliedAt;
      existing.order = index;
      continue;
    }
    byGroup.set(row.groupKey, {
      group: row.groupKey,
      appliedAt: row.appliedAt,
      migrations: [row.migration],
      order: index,
    });
  }
  return [...byGroup.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ group, appliedAt, migrations }) => ({ group, appliedAt, migrations }));
}

/**
 * Where `group` sits in this database's chain — see {@link GroupPosition}.
 *
 * The test is *is this group the tail of the **ledger***, not *is it the newest by timestamp*: a group
 * extended after another run has the later timestamp and still has that run's migration inside it, so
 * reversing it would reverse the other group's work. Hence the two halves of one rule — nothing applied
 * over the group's newest migration, and nothing applied inside it between two of its own.
 *
 * **Against the ledger, because the ledger is what comes down.** `migrateDown()` steps the ledger's tip,
 * so a group whose rows are the tail of the *group table* is still buried when an ungrouped migration sits
 * over it in the ledger — and that state is reachable from the ordinary dev loop, where `seed --redo`'s
 * reset reapplies a pending migration under no group at all. Asked of the group table alone, this returned
 * `top`, the `down` reversed a migration nobody asked about, and the refusal arrived after the damage.
 */
export async function readGroupPosition(database: D1Database, group: string): Promise<GroupPosition> {
  const db = migrationKysely<GroupDatabase>(database);
  const groupOf = new Map((await groupRows(db)).map((row) => [row.migration, row.groupKey]));
  const chain = await appliedMigrationChain(db);
  const held = (name: string): boolean => groupOf.get(name) === group;
  const first = chain.findIndex(held);
  // Nothing of this group is *applied* here: a group narrowed away, already reversed, or recorded against
  // rows the ledger no longer holds. Either way there is nothing here to step down.
  if (first === -1) return { state: "absent" };
  const last = chain.length - 1 - [...chain].reverse().findIndex(held);
  const span = chain.slice(first, last + 1);
  // Two different ways to be in the way, and the group is only on top when neither is: migrations applied
  // *over* its newest, and migrations applied *inside* it by a run that came between two of its own.
  const over = chain.slice(last + 1);
  const inside = span.filter((name) => !held(name));
  if (over.length === 0 && inside.length === 0) {
    return { state: "top", migrations: span.filter(held).reverse() };
  }
  // Newest first, over before inside, because that is the order they would have to come down in.
  const blocking = [...[...over].reverse(), ...[...inside].reverse()];
  const above = [...new Set(blocking.map((name) => groupOf.get(name)).filter(isGroupKey))];
  const ungrouped = blocking.filter((name) => !groupOf.has(name));
  const top = contiguousTipGroup(chain, groupOf);
  return { state: "buried", above, ungrouped, ...(top === undefined ? {} : { top }) };
}

/** A `groupOf` lookup that found a group, for narrowing the `above` list. */
function isGroupKey(key: string | undefined): key is string {
  return key !== undefined;
}

/**
 * The group whose own migrations are the contiguous tip of `chain`, if any.
 *
 * What it is for is the refusals: *reverse the group on top first* is only advice if such a group exists,
 * and after a group was extended over another one none does — each is inside the other, so naming either
 * prints a command that refuses in its turn and the operator is sent in a circle (#694). The candidate can
 * only be the group holding the tip migration, so there is one to test, not a search.
 */
function contiguousTipGroup(chain: readonly string[], groupOf: Map<string, string>): string | undefined {
  const tip = chain.at(-1);
  const candidate = tip === undefined ? undefined : groupOf.get(tip);
  if (candidate === undefined) return undefined;
  const held = chain.filter((name) => groupOf.get(name) === candidate).length;
  const tail = chain.slice(chain.length - held);
  return tail.every((name) => groupOf.get(name) === candidate) ? candidate : undefined;
}

/**
 * Forget the group rows of migrations that are no longer applied — what a reversal writes once the `down`
 * has run. By migration name alone, because the ledger's name is unique: one applied migration, one row.
 * A database with no group table has nothing to forget.
 */
export async function forgetMigrationGroups(database: D1Database, migrations: readonly string[]): Promise<void> {
  if (migrations.length === 0) return;
  const db = migrationKysely<GroupDatabase>(database);
  if (!(await groupTableExists(db))) return;
  // An `in (…)` list binds one parameter per value, so a long reversal is chunked under D1's cap too.
  for (const chunk of chunkByBoundParameters(migrations, 0)) {
    await db.deleteFrom("pithy_migrations_groups").where("migration", "in", chunk).execute();
  }
}
