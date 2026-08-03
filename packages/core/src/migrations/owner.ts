// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import { SQLiteDate } from "../data/codecs";
import { ConflictError, ValidationError } from "../error/pithyError";
import { MIGRATION_OWNER_TABLE, migrationKysely } from "./bookkeeping";

/**
 * Which project owns a database — the guard behind `pithy migrate`.
 *
 * Table names stay `pithy_<capability>_<table>` in every project, on purpose: they are baked into
 * migration keys and every meta-test, and the prefix exists to avoid clashing with the *adopter's*
 * tables, not with another Pithy app's. The cost is that two unrelated projects pointed at one D1
 * merge their schemas silently, each applying migrations the other has never heard of. So the name
 * stays and the database records its owner instead: the first run stamps the project, every later run
 * checks it, and a second project is refused by name rather than quietly joined.
 *
 * The stamp is bookkeeping, not a migration. It sits in its own table beside the ledger and the lock,
 * created on demand, so no capability ships it, `--rollback` cannot step it back, and `pithy seed
 * --redo`'s full reset — which rolls every migration down and back up — cannot wipe it. A database
 * that once belonged to a project keeps saying so even with no schema left in it.
 *
 * Workers sharing one database is the supported path and is unaffected: they share by declaring the
 * same binding name *within one project*, so every one of them claims the same owner.
 */

/** The single bookkeeping row's fixed primary key — one owner per database, by construction. */
const OWNER_ROW_ID = 1;

/** The recorded owner of a database: who stamped it, and when. */
export const MigrationOwner = z
  .object({
    project: z
      .string()
      .describe("The owning project — the root pithy.config.ts `name`, kebab-cased, as it was at first migrate."),
    stampedAt: SQLiteDate.describe("When the project first claimed this database. Never rewritten by a later run."),
  })
  .describe("One database's owning project, recorded in the migration bookkeeping the first time it is migrated.");
export type MigrationOwner = z.output<typeof MigrationOwner>;

/**
 * The owner table as Kysely sees it: the schema's `z.input` (SQLite row) side — derived, never a
 * hand-written row interface — plus the fixed primary key that makes a second owner unrepresentable.
 * The key is the table's real name because `MIGRATION_OWNER_TABLE` is the single source of it;
 * `CamelCasePlugin` passes an already-snake_case identifier through unchanged, and still maps the
 * `stampedAt` column both ways.
 */
interface OwnerDatabase {
  pithy_migrations_owner: z.input<typeof MigrationOwner> & { id: number };
}

/** How a claim resolved: the database had no owner, or it already had this one. */
export type OwnershipOutcome = "adopted" | "confirmed";

/** The result of a successful claim — a refused one throws instead. */
export interface ProjectOwnership {
  /** The claiming project, which is now (or already was) the recorded owner. */
  project: string;
  /** `adopted` on the first migrate of a database, `confirmed` on every run after it. */
  outcome: OwnershipOutcome;
  /** When the owner was first recorded — the original stamp, not this run. */
  stampedAt: Date;
}

/** Who is claiming, and how to name the database if the claim is refused. */
export interface ClaimOwnershipOptions {
  /** The claiming project — the root `pithy.config.ts` `name`, kebab-cased (`requireProjectName`). */
  project: string;
  /** The binding this database is reached by (`DB`), so a refusal names it. Optional. */
  binding?: string;
}

/** Whether the owner table has been created yet — a plain `sqlite_master` select, which D1 permits. */
async function ownerTableExists(db: Kysely<OwnerDatabase>): Promise<boolean> {
  const { rows } = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name = ${MIGRATION_OWNER_TABLE}`.execute(db);
  return rows.length > 0;
}

/** The recorded owner, validated through the codec, or `undefined` when nothing has claimed it. */
async function currentOwner(db: Kysely<OwnerDatabase>): Promise<MigrationOwner | undefined> {
  if (!(await ownerTableExists(db))) return undefined;
  const row = await db
    .selectFrom("pithy_migrations_owner")
    .select(["project", "stampedAt"])
    .where("id", "=", OWNER_ROW_ID)
    .executeTakeFirst();
  return row ? MigrationOwner.parse(row) : undefined;
}

/** The refusal: both project names in the problem line, both remedies in the action line. */
function foreignDatabase(owner: string, project: string, binding: string | undefined): ConflictError {
  return new ConflictError({
    message: `${binding ?? "This database"} belongs to project "${owner}", not "${project}".`,
    action: `Bind ${project} to its own database, or set the project name back to ${owner}. Run pithy migrate again.`,
    detail: `Recorded owner "${owner}" in ${MIGRATION_OWNER_TABLE}.`,
  });
}

/**
 * The project recorded as this database's owner, or `undefined` when none is — read-only, creating
 * nothing. `pithy doctor` and any other reporter reads the stamp through this; only
 * {@link claimMigrationOwnership} writes it.
 */
export async function readMigrationOwner(database: D1Database): Promise<MigrationOwner | undefined> {
  return currentOwner(migrationKysely<OwnerDatabase>(database));
}

/**
 * Claim a database for a project, or refuse it to a foreign one. Idempotent and safe to re-run: an
 * unstamped database is adopted (nothing has shipped, so a first run has no ambiguity to preserve),
 * the owning project re-claims as a no-op, and any other project throws a `core/conflict` naming both
 * projects. The insert is `on conflict do nothing` against a fixed primary key and is followed by a
 * re-read, so two runs racing the very first claim settle on one owner rather than two rows.
 */
export async function claimMigrationOwnership(
  database: D1Database,
  options: ClaimOwnershipOptions,
): Promise<ProjectOwnership> {
  const project = options.project.trim();
  if (!project) {
    throw new ValidationError({
      message: "A migration run needs a project name.",
      action: "Set `name` in pithy.config.ts. It is what stamps the database as this project's.",
    });
  }

  const db = migrationKysely<OwnerDatabase>(database);
  const existing = await currentOwner(db);
  if (existing) {
    if (existing.project !== project) throw foreignDatabase(existing.project, project, options.binding);
    return { project, outcome: "confirmed", stampedAt: existing.stampedAt };
  }

  await db.schema
    .createTable(MIGRATION_OWNER_TABLE)
    .ifNotExists()
    .addColumn("id", "integer", (column) => column.primaryKey())
    .addColumn("project", "text", (column) => column.notNull())
    .addColumn("stampedAt", "integer", (column) => column.notNull())
    .execute();

  const record = MigrationOwner.encode({ project, stampedAt: new Date() });
  await db
    .insertInto("pithy_migrations_owner")
    .values({ id: OWNER_ROW_ID, ...record })
    .onConflict((conflict) => conflict.doNothing())
    .execute();

  // Re-read rather than trust the insert: a concurrent first run may have won the row.
  const settled = await currentOwner(db);
  if (!settled) {
    throw new ConflictError({
      message: `${options.binding ?? "This database"} could not be stamped as "${project}".`,
      action: "Check the database is writable. Run pithy migrate again.",
      detail: `No row in ${MIGRATION_OWNER_TABLE} after the claim insert.`,
    });
  }
  if (settled.project !== project) throw foreignDatabase(settled.project, project, options.binding);
  return { project, outcome: "adopted", stampedAt: settled.stampedAt };
}
