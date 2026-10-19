// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Relax `pithy_auth_accounts.issuer` to nullable and drop the `(issuer, accountId)` unique index (#787).
 *
 * **Better Auth reverted `issuer` in a patch release.** 1.7.0 made an account the pair `(issuer, accountId)`,
 * required `issuer`, and `0001_init` followed it (#451). 1.7.3 restored the 1.6 model, which identifies an
 * account by `(providerId, accountId)` again (better-auth/better-auth#11153), and stopped writing `issuer`
 * at all. So on 1.7.3 and later every insert into this table failed on the `NOT NULL`, and every email OTP
 * sign-in answered 500. 1.7.3 also validates the schema at initialization, which is where the logged
 * `Database schema mismatch` came from.
 *
 * **This is Better Auth's own cleanup, from its 1.7 upgrade guide.** Drop the unique index first, then
 * relax the constraint. No backfill. The column stays, with every value in it: a Worker migrated under
 * 1.7.1 loses nothing, and the step can be reversed. Dropping the column is a separate decision.
 *
 * **A `0003`, never an edit to `0001_init`.** `0001` has shipped and has run against real rows, so it is
 * history. A fresh install runs `0001` then this, and ends in the same schema as an upgraded one.
 *
 * **SQLite has no `ALTER COLUMN`, so relaxing a constraint is a table rebuild.** A new table, every row
 * copied across, the old one dropped, the new one renamed into its place, its indexes recreated. Nothing
 * references this table by foreign key, so dropping it cascades into nothing.
 *
 * **The rebuild reads the table it replaces rather than a column list written here.** An adopter's Better
 * Auth plugin can add columns and indexes to this table through its own `0002_plugin_<id>` migration, which
 * sorts before this one, and a rebuild from a fixed list would drop them and their data without a word. So
 * the columns come from `pragma_table_info` and the indexes from `sqlite_master`, and only `issuer`'s
 * constraint and the one index are changed.
 *
 * **The swap is one round trip.** The migration runner queues schema statements and sends a run of them as
 * one `d1.batch()`, which D1 applies as one transaction. A raw `sql` template is never queued: it flushes
 * the queue and runs alone. So the index drops, the table drop, the rename and every index recreate are
 * built as schema statements, back to back, and either all of them apply or none does. Separate, a run that
 * died after the drop would leave auth with no accounts table, and one that died after the rename would
 * leave it with no indexes and a retry that records Success over the loss.
 *
 * `down` is the tested inverse: the same rebuild with `NOT NULL` back, then the unique index, in the same
 * batch. It refuses before it touches anything when a row has no `issuer`, since the constraint cannot hold
 * over that row, or when two rows share an `(issuer, accountId)`, since the index cannot.
 */

const ACCOUNTS = "pithy_auth_accounts";
const ACCOUNTS_NEXT = "pithy_auth_accounts_next";

/** One column of a table, as SQLite's `pragma_table_info` reports it. */
interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  /** `dflt_value`, renamed in the query: the `CamelCasePlugin` would rename a snake_case result key. */
  initial: string | null;
  pk: number;
}

/**
 * Every column of the accounts table, in declaration order.
 *
 * The names come back snake_case, as the database stores them, and go back into the rebuild the same
 * way: `CamelCasePlugin` leaves a name with no capital in it as it is.
 */
async function accountColumns(db: Kysely<unknown>): Promise<TableColumn[]> {
  const { rows } =
    await sql<TableColumn>`select name, type, "notnull", dflt_value as initial, pk from pragma_table_info(${ACCOUNTS}) order by cid`.execute(
      db,
    );
  return rows;
}

/** The DDL of every index on the accounts table that SQLite did not create for itself. */
async function accountIndexes(db: Kysely<unknown>): Promise<{ name: string; sql: string }[]> {
  const { rows } = await sql<{
    name: string;
    sql: string;
  }>`select name, sql from sqlite_master where type = 'index' and tbl_name = ${ACCOUNTS} and sql is not null order by name`.execute(
    db,
  );
  return rows;
}

/** One column's definition, as `create table` takes it. */
function columnDefinition(column: TableColumn, issuerNotNull: boolean): ReturnType<typeof sql> {
  const parts = [sql.id(column.name), sql.raw(column.type)];
  if (column.pk === 1) parts.push(sql`primary key`);
  const notNull = column.name === "issuer" ? issuerNotNull : column.notnull === 1;
  if (notNull && column.pk !== 1) parts.push(sql`not null`);
  if (column.initial !== null) parts.push(sql`default ${sql.raw(column.initial)}`);
  return sql.join(parts, sql` `);
}

/**
 * Rebuild the accounts table with `issuer` nullable or not, keeping every other column, row and index.
 * The unique `(issuer, accountId)` index is dropped before the rebuild and is not carried across.
 */
async function rebuild(db: Kysely<unknown>, issuerNotNull: boolean): Promise<void> {
  const columns = await accountColumns(db);
  if (!columns.some((column) => column.name === "issuer")) {
    throw new InternalError({
      message: `${ACCOUNTS} has no issuer column, so there is no constraint to change.`,
      action: "Compare the table with auth's 0001_init. Something outside the migration chain has reshaped it.",
    });
  }
  if (columns.filter((column) => column.pk > 0).length !== 1) {
    throw new InternalError({
      message: `${ACCOUNTS} does not have the single-column primary key 0001_init gave it.`,
      action: "Compare the table with auth's 0001_init. Something outside the migration chain has reshaped it.",
    });
  }

  // A rebuild an earlier run left half-done. The create and the copy below are raw `sql` and each its own
  // round trip, so a run that died after either leaves this behind beside an intact table, indexes
  // included, and the retry would fail on it. The checks above have just read the real table whole, so
  // nothing here is the only copy of anything.
  await sql`drop table if exists ${sql.id(ACCOUNTS_NEXT)}`.execute(db);

  // First, as Better Auth's upgrade guide orders it. `ifExists`, because `down` runs this rebuild too and
  // the index is already gone by then.
  await db.schema.dropIndex("pithyAuthAccountsIssuerAccountIdIdx").ifExists().execute();
  const indexes = await accountIndexes(db);

  await sql`create table ${sql.id(ACCOUNTS_NEXT)} (${sql.join(columns.map((column) => columnDefinition(column, issuerNotNull)))})`.execute(
    db,
  );
  const names = sql.join(columns.map((column) => sql.id(column.name)));
  await sql`insert into ${sql.id(ACCOUNTS_NEXT)} (${names}) select ${names} from ${sql.id(ACCOUNTS)}`.execute(db);

  // From here to the end of the migration body, every statement is a schema statement, so the runner sends
  // them as one batch: each index drop, the table drop, the rename, each index recreate, and in `down` the
  // unique index after them. A failure anywhere in it rolls all of it back, and the retry finds the
  // original table whole, its indexes on it. Nothing in this stretch may be a raw `sql` template, which
  // would split the batch.
  //
  // Each index is dropped by name before the table, as every `down` in the kit drops what it created, and
  // recreated after the rename. Inside the one batch that costs nothing: the original keeps every index
  // unless the whole batch applies. The index names are SQLite's own, so they skip the `CamelCasePlugin`.
  // The table names go through it, so they are written camelCase, as `0001_init` writes them.
  for (const index of indexes) await db.withoutPlugins().schema.dropIndex(index.name).execute();
  await db.schema.dropTable("pithyAuthAccounts").execute();
  await db.schema.alterTable("pithyAuthAccountsNext").renameTo("pithyAuthAccounts").execute();
  for (const index of indexes) await db.executeQuery(recreateIndex(db, index));
}

/**
 * One index's recreate, as a schema statement carrying the DDL SQLite kept for it, verbatim.
 *
 * Verbatim, because a plugin's index can be partial, on an expression, or collated, and rebuilding it from
 * a builder would mean parsing that back out of its DDL. The DDL names the table by the name the rebuilt
 * one has once renamed. The statement is a `create index` node with that text as its SQL, which is exactly
 * what it is, and the node is what lets the runner queue it into the batch the drop and rename are in. The
 * runner reads only the node's kind, so the builder's column is a placeholder that never reaches SQLite.
 */
function recreateIndex(db: Kysely<unknown>, index: { name: string; sql: string }): CompiledQuery {
  const node = db.withoutPlugins().schema.createIndex(index.name).on(ACCOUNTS).column("id").compile();
  return { ...node, sql: index.sql };
}

export const auth_0003_account_issuer_nullable: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await rebuild(db, false);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    const { rows: unissued } = await sql<{
      count: number;
    }>`select count(*) as count from ${sql.id(ACCOUNTS)} where issuer is null`.execute(db);
    const missing = Number(unissued[0]?.count ?? 0);
    if (missing > 0) {
      throw new ConflictError({
        message: `Cannot restore NOT NULL on ${ACCOUNTS}.issuer. ${missing} account row(s) have no issuer. Nothing was changed.`,
        action:
          "Better Auth 1.7.3 and later never write an issuer. Fill the column for those rows, or stay on this migration.",
      });
    }
    const { rows: shared } = await sql<{
      count: number;
    }>`select count(*) as count from (select 1 from ${sql.id(ACCOUNTS)} group by issuer, account_id having count(*) > 1)`.execute(
      db,
    );
    const duplicated = Number(shared[0]?.count ?? 0);
    if (duplicated > 0) {
      throw new ConflictError({
        message: `Cannot restore the unique (issuer, account_id) index on ${ACCOUNTS}. ${duplicated} pair(s) are held by more than one row. Nothing was changed.`,
        action: "Resolve the duplicate accounts first. Each pair is one account at one identity provider.",
      });
    }

    await rebuild(db, true);
    await db.schema
      .createIndex("pithyAuthAccountsIssuerAccountIdIdx")
      .on("pithyAuthAccounts")
      .columns(["issuer", "accountId"])
      .unique()
      .execute();
  },
};
