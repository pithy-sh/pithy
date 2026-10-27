// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { appliedMigrationChain, migrationKysely } from "@pithy-sh/core/src/migrations/bookkeeping";
import { z } from "zod";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type MigrationFanOutOptions, type ProjectDatabase, withProjectDatabases } from "../migrations/run";
import { startStep } from "../terminal/progress";
import {
  BACKUP_FORMAT,
  type BackupManifest,
  type BackupMigrations,
  D1_MAX_STATEMENT_BYTES,
  insertLine,
  insertPrefix,
  OversizedRow,
  quoteIdentifier,
  renderSchemaSql,
  rowLiteral,
  type SchemaStatement,
  statementBytes,
} from "./files";
import { readColumns, readReferences, readSchema } from "./inspect";
import { ownedNames } from "./owned";
import { leftOutReason, planBackup } from "./schema";

/**
 * **`pithy backup`: every D1 an environment's Workers bind, off Cloudflare as plain files (#848).**
 *
 * Found the way `pithy migrate` finds them ({@link withProjectDatabases}), so a database two Workers share,
 * or every environment shares, is dumped once. Each gets a folder of the four files `./files` describes.
 * Rows are read with `SELECT` over the D1 binding or REST client, never `wrangler d1 export`, which fails
 * outright on a database holding an FTS5 table. What is left out is decided from the schema (`./schema`).
 */

/** The rows read per round trip. */
const PAGE_SIZE = 200;

/**
 * A backup holds every row — live session tokens, OAuth tokens, password hashes — so it is kept the way the
 * kit keeps every credential file: its folders open to their owner only, its files readable by them alone.
 */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** One database's backup, as the command reports it. */
export const DatabaseBackup = z
  .object({
    binding: z.string().describe("The D1 binding, as `wrangler.jsonc` declares it."),
    database: z.string().describe("The database name — a capability's `databases` key."),
    folder: z.string().describe("Its folder under the output directory."),
    tables: z.number().int().nonnegative().describe("How many tables' rows were dumped."),
    rows: z.number().int().nonnegative().describe("How many rows were dumped, across them all."),
    virtualTables: z
      .array(z.string().describe("A virtual table's name."))
      .describe("Every virtual table left out. A restore rebuilds or recreates each."),
    restorable: z.boolean().describe("Whether D1 can take these files back."),
    oversized: z.array(OversizedRow).describe("Every row over D1's statement limit, by file and line."),
  })
  .describe("One database's backup.");
export type DatabaseBackup = z.infer<typeof DatabaseBackup>;

/** Options for {@link runBackup}: the fan-out, and what to stamp and where to write. */
export interface BackupOptions extends MigrationFanOutOptions {
  /** The project — the root `pithy.config.ts` `name`. Recorded, so a restore can say whose dump it is. */
  project: string;
  /** The directory to write into. Created; refused when it already holds anything. */
  output: string;
  /** The `@pithy-sh/cli` version taking the backup. */
  kitVersion: string;
  /** When the backup is taken. A seam for tests. */
  now?: Date;
  /**
   * Records the export. Every row of every database leaves the account — session tokens, OAuth tokens,
   * password hashes — so the trail says who took them, from which environment, and which databases.
   */
  audit?: CliAuditEmit;
}

/** The default output directory: `backups/<env>-<timestamp>`, with the colons a filesystem may refuse made dashes. */
export function defaultBackupDir(env: string, now: Date): string {
  return join(
    "backups",
    `${env}-${now
      .toISOString()
      .replace(/\.\d+Z$/, "Z")
      .replace(/:/g, "-")}`,
  );
}

/** Refuse a directory that already holds anything: a backup never writes over another. */
async function assertEmptyOutput(output: string): Promise<void> {
  const entries = await readdir(output).catch(() => []);
  if (entries.length === 0) return;
  throw new ValidationError({
    message: `${output} already holds files.`,
    action: "Pass --output with a new or empty directory. A backup never writes over another.",
  });
}

/**
 * One folder name per database: the binding; the binding and database name where two Workers bind two
 * databases to one binding; and the store or remote id too where those two databases share a name. Never one
 * folder for two databases — `mkdir` is recursive, so the second would write over the first in silence.
 */
export function folderNames(databases: readonly Pick<ProjectDatabase, "binding" | "database" | "target">[]): string[] {
  return databases.map((database) => {
    const sameBinding = databases.filter((other) => other.binding === database.binding);
    if (sameBinding.length === 1) return database.binding;
    const sameName = sameBinding.filter((other) => other.database === database.database);
    return sameName.length === 1
      ? `${database.binding}-${database.database}`
      : `${database.binding}-${database.database}-${database.target}`;
  });
}

/** Back up every database in scope. Returns one row per database, in fan-out order. */
export async function runBackup(options: BackupOptions): Promise<DatabaseBackup[]> {
  await assertEmptyOutput(options.output);
  await mkdir(options.output, { recursive: true, mode: PRIVATE_DIR });
  // An empty directory passed as --output keeps the mode it was made with; it is about to hold the rows.
  await chmod(options.output, PRIVATE_DIR);
  const takenAt = (options.now ?? new Date()).toISOString();
  const audit = options.audit ?? (async () => {});
  return withProjectDatabases(options, async (opened) => {
    const folders = folderNames(opened.map((entry) => entry.database));
    // Recorded after the dump, as it went: which databases, never what any row holds.
    const event = (outcome: "success" | "failure", metadata: Record<string, unknown>) =>
      audit({
        action: "backup/exported",
        outcome,
        severity: "warning",
        resourceType: "environment",
        resourceId: options.env,
        metadata,
      });
    const reports: DatabaseBackup[] = [];
    try {
      for (const [index, { database, d1 }] of opened.entries()) {
        const folder = folders[index] ?? database.binding;
        startStep(`Backing up ${database.binding} (${database.database})`);
        reports.push(
          await backupDatabase(d1, database, { ...options, takenAt, folder, dir: join(options.output, folder) }),
        );
      }
    } catch (error) {
      await event("failure", {
        databases: opened.map(({ database }) => ({
          binding: database.binding,
          database: database.database,
          id: database.target,
        })),
      });
      throw error;
    }
    await event("success", {
      databases: reports.map((report, index) => ({
        binding: report.binding,
        database: report.database,
        id: opened[index]?.database.target,
        tables: report.tables,
        rows: report.rows,
        restorable: report.restorable,
      })),
    });
    return reports;
  });
}

/** Write one database's four files and report what they hold. */
async function backupDatabase(
  d1: D1Database,
  database: ProjectDatabase,
  options: BackupOptions & { takenAt: string; folder: string; dir: string },
): Promise<DatabaseBackup> {
  await mkdir(options.dir, { recursive: true, mode: PRIVATE_DIR });
  const applied = await appliedMigrationChain(migrationKysely(d1));
  const schema = await readSchema(d1);
  const kinds = new Map(schema.tableList.map((row) => [row.name, row.type]));
  const candidates = schema.master
    .filter((row) => row.type === "table" && leftOutReason(row.name, kinds.get(row.name) ?? "table") === null)
    .map((row) => row.name);
  const plan = planBackup({
    master: schema.master,
    tableList: schema.tableList,
    owned: await ownedNames(database.provider, applied),
    references: await readReferences(d1, candidates),
  });
  const withoutRowid = new Set(schema.tableList.filter((row) => row.wr === 1).map((row) => row.name));
  const label = `${database.binding} (${database.database}), ${options.env}, ${options.takenAt}`;

  const { tables, oversized } = await writeData(d1, join(options.dir, "data.sql"), plan.data, withoutRowid, label);

  const statements: SchemaStatement[] = [
    ...plan.unownedTables.map((one) => ({ phase: "before" as const, type: one.type, name: one.name, sql: one.sql })),
    ...plan.unownedAfter.map((one) => ({ phase: "after" as const, type: one.type, name: one.name, sql: one.sql })),
  ];
  await writeFile(
    join(options.dir, "schema.sql"),
    renderSchemaSql(
      `-- Backup of ${label}.\n-- What no migration makes. "before" runs ahead of data.sql, "after" behind it.`,
      statements,
    ),
    { mode: PRIVATE_FILE },
  );

  const migrations: BackupMigrations = {
    format: BACKUP_FORMAT,
    kitVersion: options.kitVersion,
    project: options.project,
    env: options.env,
    binding: database.binding,
    database: database.database,
    source: database.target,
    workers: database.workers,
    applied,
  };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    takenAt: options.takenAt,
    tables,
    leftOut: plan.leftOut,
    virtualTables: plan.virtual,
    skippedTriggers: plan.skippedTriggers.map((one) => ({ name: one.name, table: one.table, sql: one.sql })),
    restorable: oversized.length === 0,
    oversized,
  };
  await writeFile(join(options.dir, "migrations.json"), `${JSON.stringify(migrations, null, 2)}\n`, {
    mode: PRIVATE_FILE,
  });
  await writeFile(join(options.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: PRIVATE_FILE,
  });

  return {
    binding: database.binding,
    database: database.database,
    folder: options.folder,
    tables: tables.length,
    rows: tables.reduce((sum, table) => sum + table.rows, 0),
    virtualTables: plan.virtual.map((one) => one.name),
    restorable: manifest.restorable,
    oversized,
  };
}

/**
 * Stream every table's rows into `data.sql`, one `INSERT` per line, in the plan's reference order.
 *
 * Paged by key — `rowid`, or the primary key for a `WITHOUT ROWID` table — each page asking for the rows
 * after the last key it read, so the order is stable and a parent row tends to come before a row of the
 * same table referencing it. Paging by key rather than by `OFFSET` is what keeps a live database honest: a
 * row deleted behind the cursor while the backup runs moves no other row out from under it, and no page
 * rescans the ones before it. The backup is still not a snapshot — each page is its own read, and tables
 * are read one after another — so D1 Time Travel is the consistent copy. A line over D1's statement limit
 * is still written — the files stay a complete copy `sqlite3` imports — and named by its line.
 */
async function writeData(
  d1: D1Database,
  path: string,
  tables: readonly string[],
  withoutRowid: ReadonlySet<string>,
  label: string,
): Promise<{ tables: BackupManifest["tables"]; oversized: OversizedRow[] }> {
  const file = await open(path, "w", PRIVATE_FILE);
  const counted: BackupManifest["tables"] = [];
  const oversized: OversizedRow[] = [];
  let line = 0;
  const write = async (text: string): Promise<void> => {
    line += 1;
    await file.write(`${text}\n`);
  };
  try {
    await write(`-- Backup of ${label}. Rows only; migrations.json says which migrations make the schema.`);
    await write("PRAGMA defer_foreign_keys = on;");
    for (const table of tables) {
      const columns = await readColumns(d1, table);
      const names = columns.map((column) => column.name);
      const prefix = insertPrefix(table, names);
      const keys = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => quoteIdentifier(column.name));
      // Each key comes back as its own SQL literal, so the next page's bound is written exactly as read.
      const key = withoutRowid.has(table) && keys.length > 0 ? keys : ["rowid"];
      const keyLiterals = key.map((column, index) => `quote(${column}) AS k${index}`).join(", ");
      let after: string[] | null = null;
      let rows = 0;
      for (;;) {
        const where: string = after === null ? "" : ` WHERE (${key.join(", ")}) > (${after.join(", ")})`;
        const page: D1Result<Record<string, string>> = await d1
          .prepare(
            `SELECT ${rowLiteral(names)} AS v, ${keyLiterals} FROM ${quoteIdentifier(table)}${where} ORDER BY ${key.join(", ")} LIMIT ${PAGE_SIZE}`,
          )
          .all<Record<string, string>>();
        const results: Record<string, string>[] = page.results ?? [];
        for (const result of results) {
          const statement = insertLine(prefix, String(result.v));
          await write(statement);
          rows += 1;
          const bytes = statementBytes(statement);
          if (bytes >= D1_MAX_STATEMENT_BYTES) oversized.push({ file: "data.sql", line, table, bytes });
        }
        const last: Record<string, string> | undefined = results.at(-1);
        if (results.length < PAGE_SIZE || last === undefined) break;
        after = key.map((_, index) => String(last[`k${index}`]));
      }
      counted.push({ name: table, rows });
    }
  } finally {
    await file.close();
  }
  return { tables: counted, oversized };
}
