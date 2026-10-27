// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type Expression, type ExpressionBuilder, type Kysely, type SqlBool, sql } from "kysely";
import type { z } from "zod";
import { createDatabase } from "../data/db";
import { type ErasingPurgeContribution, exportRows, type PurgeContext, purgeBinding } from "./purge";

/**
 * The purge contribution most capabilities need, written once (#814): rows in D1 that name a person by a column,
 * exported on an access request and deleted by a purge.
 *
 * `@pithy-sh/rating`'s ratings, `@pithy-sh/leaderboard`'s entries, `@pithy-sh/matchmaking`'s friendships — each is
 * a table whose rows carry the person's id in a column, and nothing else to do with them than read them out and
 * delete them. A capability with more to do — bytes in R2, an address rather than an id, a row that must be
 * anonymized — writes its own contribution with the same types.
 *
 * **One transaction.** The deletes are one `d1.batch()`, in the order the tables are listed, so a failure leaves
 * every row where it was and the retried step erases the lot. **Idempotent**: a second run deletes nothing.
 */

/** One table a person's rows are in, and how they are found and exported. */
export interface PersonTable {
  /** The table's camelCase name, as the capability's tables map keys it. */
  readonly table: string;
  /** Its row schema. Rows are decoded through it, so the export carries the app shape and never SQLite's. */
  readonly schema: z.ZodObject;
  /** The columns that name the person. A row is theirs when any of them is the subject's id. */
  readonly columns: readonly string[];
  /**
   * Columns a row must also hold exactly — `{ subjectType: "user" }`, where one id column names people and
   * organizations both and only a person's rows are theirs.
   */
  readonly match?: Readonly<Record<string, string>>;
  /** The key the rows are exported under — `ratings`, `entries`. */
  readonly as: string;
  /** A column to read them in, so an export reads the same twice. */
  readonly orderBy?: string;
  /** Columns the export leaves out — a credential, or another person's data the row carries beside theirs. */
  readonly omit?: readonly string[];
  /**
   * A per-row redaction, for a credential that sits in a column only some rows hold it in — a Google Play purchase
   * token keys a purchase row on that rail alone. It is handed the decoded row, before `omit` drops any column, and
   * returns the row to export.
   */
  readonly redact?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/** What {@link personRowsPurge} is built from. */
export interface PersonRowsPurgeInput {
  /** The capability, for the fault a missing binding raises. */
  readonly capability: string;
  /** The one sentence the purge records with this step. */
  readonly summary: string;
  /** The D1 binding the tables live in. */
  readonly database?: string;
  /** The tables, in the order a purge deletes from them — children before the rows they reference. */
  readonly tables: readonly PersonTable[];
}

/** An untyped Kysely: each table is named by the input, not by a typed map. */
type Untyped = Kysely<Record<string, Record<string, unknown>>>;

/** `(column = id OR column = id …) AND match…` over a table's person columns. */
function theirs(
  { columns, match }: Pick<PersonTable, "columns" | "match">,
  id: string,
): (eb: ExpressionBuilder<Record<string, Record<string, unknown>>, string>) => Expression<SqlBool> {
  return (eb) =>
    eb.and([
      eb.or(columns.map((column) => eb(sql.ref(column), "=", id))),
      ...Object.entries(match ?? {}).map(([column, value]) => eb(sql.ref(column), "=", value)),
    ]);
}

/**
 * The export half alone: every row naming the person in `tables`, decoded, under each table's key. For a
 * contribution that **retains** its rows (#814) — `@pithy-sh/payments` keeps a purchase for tax law, and still
 * answers for it.
 */
export function personRowsExport(
  input: Omit<PersonRowsPurgeInput, "summary">,
): (context: PurgeContext) => Promise<Record<string, unknown>> {
  const database = input.database ?? "DB";
  return async ({ subject, env }) => {
    const db = createDatabase(purgeBinding<D1Database>(env, database, input.capability), {}) as unknown as Untyped;
    const read = await Promise.all(
      input.tables.map(async (table) => {
        let query = db.selectFrom(table.table).selectAll().where(theirs(table, subject.id));
        if (table.orderBy) query = query.orderBy(sql.ref(table.orderBy));
        const rows = (await query.execute()).map((row) => {
          const parsed = table.schema.parse(row) as Record<string, unknown>;
          const decoded = table.redact ? table.redact(parsed) : parsed;
          for (const column of table.omit ?? []) delete decoded[column];
          return decoded;
        });
        return [table.as, exportRows(rows)] as const;
      }),
    );
    return Object.fromEntries(read);
  };
}

/** Build a user contribution that exports, then on a purge deletes, every row naming the person in `tables`. */
export function personRowsPurge(input: PersonRowsPurgeInput): ErasingPurgeContribution {
  const database = input.database ?? "DB";
  const open = (env: Record<string, unknown>) => {
    const d1 = purgeBinding<D1Database>(env, database, input.capability);
    return { d1, db: createDatabase(d1, {}) as unknown as Untyped };
  };
  return {
    subject: "user",
    summary: input.summary,
    erase: async ({ subject, env }) => {
      const { d1, db } = open(env);
      const statements = input.tables.map((table) => {
        const compiled = db.deleteFrom(table.table).where(theirs(table, subject.id)).compile();
        return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
      });
      if (statements.length > 0) await d1.batch(statements);
    },
    export: personRowsExport(input),
  };
}
