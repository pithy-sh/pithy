// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **The four files a backup writes per database, and how each is read back (#848).**
 *
 * - `migrations.json` — what the dump is for: the kit version, the database, every applied migration key.
 * - `data.sql` — rows only, one `INSERT` per row and one row per line, so a line number names a row.
 * - `schema.sql` — the `CREATE` statements no migration makes, each under a `-- pithy:` marker line.
 * - `manifest.json` — every table and its row count, everything left out, and whether D1 can take it back.
 *
 * Plain SQL a person can read and `sqlite3` can import, with markers in comments, so the files stay useful
 * to someone who never runs `pithy restore`.
 */

/** D1 refuses a statement of this many bytes or more (`SQLITE_TOOBIG`). */
export const D1_MAX_STATEMENT_BYTES = 100_000;

/** The most rows a restore puts in one multi-row `INSERT`. */
const MAX_ROWS_PER_STATEMENT = 500;

/** The format both JSON files declare, bumped if either changes shape. */
export const BACKUP_FORMAT = 1;

/** `migrations.json`: what one database's dump is for. */
export const BackupMigrations = z
  .object({
    format: z.literal(BACKUP_FORMAT).describe("The backup format. Restore refuses one it does not know."),
    kitVersion: z.string().describe("The `@pithy-sh/cli` version that took the backup."),
    project: z.string().describe("The project the database belongs to — the root `pithy.config.ts` `name`."),
    env: z.string().describe("The environment it was taken from."),
    binding: z.string().describe("The D1 binding, as `wrangler.jsonc` declares it."),
    database: z.string().describe("The database name — a capability's `databases` key."),
    source: z.string().describe("The database it came from: the remote `database_id`, or the local store's id."),
    workers: z.array(z.string().describe("A Worker's name.")).describe("Every Worker bound to it."),
    applied: z
      .array(z.string().describe("A composed migration key."))
      .describe("Every migration the database had applied, in the order migrate applied them."),
  })
  .describe("What one database's dump is for. A restore compares `applied` with what it would apply.");
export type BackupMigrations = z.infer<typeof BackupMigrations>;

/** One line of `data.sql` over D1's statement limit. */
export const OversizedRow = z
  .object({
    file: z.string().describe("The file holding it: `data.sql`."),
    line: z.number().int().positive().describe("The line its `INSERT` is on."),
    table: z.string().describe("The table the row belongs to."),
    bytes: z.number().int().positive().describe("The statement's size in bytes."),
  })
  .describe("One row whose `INSERT` is too long for D1 to run.");
export type OversizedRow = z.infer<typeof OversizedRow>;

/** `manifest.json`: what one database's dump holds and leaves out. */
export const BackupManifest = z
  .object({
    format: z.literal(BACKUP_FORMAT).describe("The backup format."),
    takenAt: z.string().describe("When the backup was taken, ISO-8601."),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe("The table's name."),
            rows: z.number().int().nonnegative().describe("How many rows `data.sql` carries for it."),
          })
          .describe("One table in `data.sql`."),
      )
      .describe("Every table whose rows were dumped, in load order: parents before the tables that reference them."),
    leftOut: z
      .array(
        z
          .object({
            name: z.string().describe("The table's name."),
            reason: z
              .enum(["virtual", "shadow", "cloudflare", "sqlite", "bookkeeping"])
              .describe(
                "Why: a virtual table, one of its shadow tables, Cloudflare's own, SQLite's own, or migrate's bookkeeping.",
              ),
          })
          .describe("One table whose rows were not dumped."),
      )
      .describe("Every table left out, found from the schema."),
    virtualTables: z
      .array(
        z
          .object({
            name: z.string().describe("The virtual table's name."),
            sql: z.string().describe("The `CREATE VIRTUAL TABLE` statement that makes it again."),
          })
          .describe("One virtual table left out."),
      )
      .describe("Every virtual table left out. A restore rebuilds a kit index, and recreates an adopter's empty."),
    skippedTriggers: z
      .array(
        z
          .object({
            name: z.string().describe("The trigger's name."),
            table: z.string().describe("The table it fires on."),
            sql: z.string().describe("Its `CREATE TRIGGER` statement."),
          })
          .describe("One trigger left out."),
      )
      .describe(
        "Every trigger left out because it names a virtual table. A restore makes an adopter's again once its table is back.",
      ),
    restorable: z
      .boolean()
      .describe("Whether D1 can take these files back. False when a row's statement is over D1's limit."),
    oversized: z.array(OversizedRow).describe("Every row over D1's statement limit. Empty when `restorable`."),
  })
  .describe("What one database's dump holds, what it left out, and whether D1 can take it back.");
export type BackupManifest = z.infer<typeof BackupManifest>;

/** An identifier, double-quoted for SQLite. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The SQL expression that reads one row as the literal list of an `INSERT`, exactly.
 *
 * `quote()` is SQLite's own literal: an integer stays an integer, a real keeps its precision, a blob comes
 * back as `X'…'`, a `NULL` as `NULL`. It is read in SQL, so nothing passes through a JSON number on the
 * way. A string holding a line break is escaped instead, so every row stays on one line of `data.sql` —
 * which is what lets a line number name a row: `~` becomes `~0`, LF `~n` and CR `~r`, inside the quoted
 * literal, and three nested `replace()` calls put them back. That costs one byte per break or tilde, where
 * hex doubled the whole value and halved D1's limit for any reply with a paragraph in it, and the
 * expression stays three calls deep however many lines the value has.
 */
export function rowLiteral(columns: readonly string[]): string {
  return columns
    .map((column) => {
      const c = quoteIdentifier(column);
      const escaped = `replace(replace(replace(quote(${c}), '~', '~0'), char(10), '~n'), char(13), '~r')`;
      const restored = `'replace(replace(replace(' || ${escaped} || ', ''~n'', char(10)), ''~r'', char(13)), ''~0'', ''~'')'`;
      return `CASE WHEN typeof(${c}) = 'text' AND (instr(${c}, char(10)) > 0 OR instr(${c}, char(13)) > 0) THEN ${restored} ELSE quote(${c}) END`;
    })
    .join(" || ',' || ");
}

/** The part of a row's `INSERT` every row of one table shares. */
export function insertPrefix(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES `;
}

/** One row's line of `data.sql`. */
export function insertLine(prefix: string, literal: string): string {
  return `${prefix}(${literal});`;
}

/** A statement's size as D1 measures it: UTF-8 bytes. */
export function statementBytes(statement: string): number {
  return Buffer.byteLength(statement, "utf8");
}

/**
 * Fold `data.sql`'s single-row lines back into multi-row statements for loading.
 *
 * Consecutive rows of one table share a prefix, so they become one `INSERT … VALUES (…), (…)` — one
 * round trip instead of hundreds over D1's REST API, and one statement, so a row referencing a row
 * beside it in the same table is checked at the statement's end. Every statement stays under D1's limit
 * and {@link MAX_ROWS_PER_STATEMENT}. Comments, blank lines and anything that is not a row pass through
 * as statements of their own.
 */
export async function* loadStatements(
  lines: AsyncIterable<string> | Iterable<string>,
  prefixes: readonly string[],
): AsyncGenerator<string> {
  let prefix: string | null = null;
  let values: string[] = [];
  let bytes = 0;
  const take = (): string | null => {
    const statement = prefix !== null && values.length > 0 ? `${prefix}${values.join(", ")};` : null;
    prefix = null;
    values = [];
    bytes = 0;
    return statement;
  };
  for await (const line of lines) {
    if (line.trim() === "" || line.startsWith("--")) continue;
    const owner = prefixes.find((candidate) => line.startsWith(candidate) && line.endsWith(");"));
    if (owner === undefined) {
      const pending = take();
      if (pending !== null) yield pending;
      yield line;
      continue;
    }
    const tuple = line.slice(owner.length, -1);
    const size = statementBytes(tuple) + 2;
    if (prefix !== owner || values.length >= MAX_ROWS_PER_STATEMENT || bytes + size >= D1_MAX_STATEMENT_BYTES) {
      const pending = take();
      if (pending !== null) yield pending;
      prefix = owner;
      bytes = statementBytes(owner) + 1;
    }
    values.push(tuple);
    bytes += size;
  }
  const last = take();
  if (last !== null) yield last;
}

/** Where a `schema.sql` statement belongs in a restore: before the rows load, or after. */
export type SchemaPhase = "before" | "after";

/** One statement of `schema.sql`. */
export interface SchemaStatement {
  /** When a restore runs it. */
  phase: SchemaPhase;
  /** `table`, `view`, `index` or `trigger`. */
  type: string;
  /** The object's name. */
  name: string;
  /** The statement, without its trailing semicolon. */
  sql: string;
}

const MARKER = /^-- pithy:(before|after) (\w+) (.+)$/;

/** Write `schema.sql`: a header, then each statement under its marker line. Empty but for the header when there are none. */
export function renderSchemaSql(header: string, statements: readonly SchemaStatement[]): string {
  const body = statements.map((one) => `-- pithy:${one.phase} ${one.type} ${one.name}\n${one.sql.trimEnd()};\n`);
  return `${header}\n${body.join("")}`;
}

/** Read `schema.sql` back into its statements, by their marker lines. */
export function parseSchemaSql(text: string): SchemaStatement[] {
  const statements: SchemaStatement[] = [];
  let current: SchemaStatement | null = null;
  const body: string[] = [];
  const close = (): void => {
    if (current === null) return;
    current.sql = body.join("\n").trim().replace(/;$/, "");
    statements.push(current);
    body.length = 0;
  };
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line);
    if (marker !== null) {
      close();
      current = { phase: marker[1] as SchemaPhase, type: marker[2] ?? "", name: marker[3] ?? "", sql: "" };
      continue;
    }
    if (current !== null) body.push(line);
  }
  close();
  return statements;
}
