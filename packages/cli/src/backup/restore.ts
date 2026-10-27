// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { D1Database } from "@cloudflare/workers-types";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { generatedMigrationGroup } from "@pithy-sh/core/src/migrations/groups";
import { claimMigrationOwnership } from "@pithy-sh/core/src/migrations/owner";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { z } from "zod";
import type { CliAuditEmit, CliAuditEvent } from "../audit/cliAudit";
import { loadSupportSearch } from "../capabilities/supportProvisioner";
import { type ProjectDatabase, type ProjectDatabasesOptions, withProjectDatabases } from "../migrations/run";
import { startStep } from "../terminal/progress";
import {
  BackupManifest,
  BackupMigrations,
  insertPrefix,
  loadStatements,
  parseSchemaSql,
  quoteIdentifier,
} from "./files";
import { readColumns, readObjects } from "./inspect";
import { identifiersOf } from "./schema";

/**
 * **`pithy restore`: a backup back into an empty database, in the order that makes it whole (#848).**
 *
 * Every check runs against every database before the first write, the way a migrate's preflight does, and
 * every check that needs no database runs before a `--database` recovery database is created, so a refusal
 * leaves nothing half restored and nothing new in the account: the backup must be one D1 can take, its applied migrations must
 * be exactly what this CLI would apply, and the database must hold no table. Then, per database: claim it,
 * migrate it, make the tables no migration owns, load the rows with every trigger out of the way, put the
 * triggers back, make the indexes and triggers no migration owns, and rebuild what the backup left out.
 */

/** How a restore brings back one virtual table the backup left out. */
export const RebuiltIndex = z
  .object({
    name: z.string().describe("The virtual table's name."),
    how: z
      .enum(["provisioned", "recreated-empty"])
      .describe(
        "`provisioned`: rebuilt and backfilled through the capability's own provisioning. `recreated-empty`: made again from its recorded statement, with no rows — only you know how to refill it.",
      ),
  })
  .describe("One virtual table a restore brought back.");
export type RebuiltIndex = z.infer<typeof RebuiltIndex>;

/** One database's restore, as the command reports it. */
export const DatabaseRestore = z
  .object({
    binding: z.string().describe("The D1 binding, as `wrangler.jsonc` declares it."),
    database: z.string().describe("The database name — a capability's `databases` key."),
    target: z.string().describe("The database written to: the remote `database_id`, or the local store's id."),
    migrations: z.number().int().nonnegative().describe("How many migrations were applied before the rows loaded."),
    tables: z.number().int().nonnegative().describe("How many tables' rows were loaded."),
    rows: z.number().int().nonnegative().describe("How many rows were loaded, as the backup's manifest counts them."),
    rebuilt: z.array(RebuiltIndex).describe("Every virtual table brought back after the load."),
  })
  .describe("One database's restore.");
export type DatabaseRestore = z.infer<typeof DatabaseRestore>;

/** One database's backup, read and checked off disk. */
export interface BackupFolder {
  /** The folder holding it. */
  dir: string;
  /** `migrations.json`. */
  migrations: BackupMigrations;
  /** `manifest.json`. */
  manifest: BackupManifest;
}

/** Rebuild a capability's derived index: `provisionSearchIndex`, loaded from the project's own install. */
export type SearchIndexRebuild = (
  projectDir: string,
  d1: D1Database,
  wanted: boolean,
) => Promise<{ table: string; action: string }>;

/** Options for {@link runRestore}. */
export interface RestoreOptions extends ProjectDatabasesOptions {
  /** The project — the root `pithy.config.ts` `name`. Every restored database is claimed for it. */
  project: string;
  /** The backup directory: a `pithy backup` output, or one database's folder inside it. */
  input: string;
  /** The `@pithy-sh/cli` version running the restore, named when a backup's migrations differ. */
  kitVersion: string;
  /** The migration group the restore's migrate runs under. Absent, it generates one. */
  group?: string;
  /**
   * The recovery database to write to instead of the one the stanza names (`--database`): resolved — found or
   * created — only once the backup's files have passed their checks, so a refused backup creates nothing.
   * Answers the store or remote id to open.
   */
  recovery?: () => Promise<string>;
  /** Test seam for the support index rebuild. Defaults to the adopter's own `@pithy-sh/support`. */
  searchIndex?: SearchIndexRebuild;
  /**
   * Records the restore, and the support index it rebuilt, once every database has loaded — never before:
   * the audit sink writes into the environment's app database, and a row there ahead of the load would
   * trip the restore's own check that the database is empty.
   */
  audit?: CliAuditEmit;
}

/** The default rebuild: the same `provisionSearchIndex` `pithy support provision` runs. */
const supportSearchIndex: SearchIndexRebuild = async (projectDir, d1, wanted) => {
  const { provisionSearchIndex, SEARCH_TABLE } = await loadSupportSearch(projectDir);
  return { table: SEARCH_TABLE, action: await provisionSearchIndex(d1, wanted) };
};

/** Read one folder's two JSON files, refusing either that is not what a backup writes. */
async function readFolder(dir: string): Promise<BackupFolder> {
  const read = async <T>(name: string, schema: z.ZodType<T>): Promise<T> => {
    const raw = await readFile(join(dir, name), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new ValidationError({
      message: `${join(dir, name)} is not a backup file.`,
      action: `Pass a directory ${commandName("backup")} wrote, unchanged.`,
    });
  };
  return {
    dir,
    migrations: await read("migrations.json", BackupMigrations),
    manifest: await read("manifest.json", BackupManifest),
  };
}

/** Every database backup under `input`: the folder itself, or each folder inside it holding a `migrations.json`. */
export async function readBackup(input: string): Promise<BackupFolder[]> {
  const isBackup = async (dir: string): Promise<boolean> =>
    stat(join(dir, "migrations.json")).then(
      () => true,
      () => false,
    );
  if (await isBackup(input)) return [await readFolder(input)];
  const entries = await readdir(input, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    throw new NotFoundError({
      message: `${input} does not exist.`,
      action: `Pass the directory ${commandName("backup")} wrote.`,
    });
  }
  const folders: BackupFolder[] = [];
  for (const entry of entries.filter((one) => one.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (await isBackup(join(input, entry.name))) folders.push(await readFolder(join(input, entry.name)));
  }
  if (folders.length === 0) {
    throw new NotFoundError({
      message: `${input} holds no backup.`,
      action: `Pass the directory ${commandName("backup")} wrote, or one database's folder inside it.`,
    });
  }
  return folders;
}

/** The refusal for a backup D1 cannot take back, naming where to go instead. */
function notRestorable(folder: BackupFolder): PreconditionFailedError {
  const first = folder.manifest.oversized[0];
  const where = first === undefined ? "" : ` ${first.file} line ${first.line} is ${first.bytes} bytes.`;
  return new PreconditionFailedError({
    message: `${folder.migrations.binding}: this backup holds a row over D1's 100,000-byte statement limit, so D1 cannot take it back.${where}`,
    action:
      "Recover in place with D1 Time Travel (wrangler d1 time-travel restore), or import the files into SQLite with sqlite3.",
  });
}

/** The refusal for a backup whose migrations differ from this CLI's, naming both versions and each side's keys. */
function migrationsDiffer(
  folder: BackupFolder,
  kitVersion: string,
  onlyBackup: readonly string[],
  onlyHere: readonly string[],
): PreconditionFailedError {
  const sides = [
    onlyBackup.length > 0 ? `Only in the backup: ${onlyBackup.join(", ")}.` : null,
    onlyHere.length > 0 ? `Only here: ${onlyHere.join(", ")}.` : null,
  ].filter((side): side is string => side !== null);
  return new PreconditionFailedError({
    message: `${folder.migrations.binding}: the backup was taken by kit ${folder.migrations.kitVersion} and this is ${kitVersion}, and their migrations differ. ${sides.join(" ")}`,
    action: `Run ${commandName("restore")} from @pithy-sh/cli ${folder.migrations.kitVersion}, with the capabilities the backup was taken with. Nothing was written.`,
  });
}

/** Refuse a backup whose applied migrations are not exactly the ones this CLI would apply to its database. */
async function assertSameMigrations(
  folder: BackupFolder,
  database: Pick<ProjectDatabase, "provider">,
  kitVersion: string,
): Promise<void> {
  const here = Object.keys(await database.provider.getMigrations()).sort();
  const theirs = folder.migrations.applied;
  const onlyBackup = theirs.filter((key) => !here.includes(key));
  const onlyHere = here.filter((key) => !theirs.includes(key));
  if (onlyBackup.length > 0 || onlyHere.length > 0) throw migrationsDiffer(folder, kitVersion, onlyBackup, onlyHere);
}

/** Refuse a database that holds any table: a restore never writes over data. */
async function assertEmpty(database: ProjectDatabase, d1: D1Database): Promise<void> {
  const tables = (await readObjects(d1)).filter((row) => row.type === "table").map((row) => row.name);
  if (tables.length > 0) {
    throw new ConflictError({
      message: `${database.binding} (${database.target}) is not empty. It holds ${tables.join(", ")}.`,
      action:
        "Restore into a fresh database with --database <name>. Overwriting live data is D1 Time Travel's job. Nothing was written.",
    });
  }
}

/** Whether a database in scope is the one a backup folder was taken from: the same binding and database name. */
function isFolderOf(folder: BackupFolder, database: { binding: string; database: string }): boolean {
  return database.binding === folder.migrations.binding && database.database === folder.migrations.database;
}

/** What tells two databases in scope apart, even two of one name on one binding: the Workers bound to each. */
type DatabaseIdentity = Pick<ProjectDatabase, "binding" | "database" | "databaseId" | "workers">;
function identityKey(database: DatabaseIdentity): string {
  return JSON.stringify([database.binding, database.database, database.databaseId ?? null, database.workers]);
}

/** The refusal for a backup folder that two databases in scope could be: two Workers bind one name to each. */
function ambiguous(folder: BackupFolder, matches: readonly DatabaseIdentity[]): ValidationError {
  const workers = matches.flatMap((one) => one.workers);
  return new ValidationError({
    message: `${folder.migrations.binding} (${folder.migrations.database}) is ${matches.length} databases here, one each for ${workers.join(", ")}.`,
    action: `Pass --worker with one of ${workers.join(", ")}, and the folder of the database to restore into it. Nothing was written.`,
  });
}

/** The refusal for two backup folders that would both restore into one database. */
function twoFoldersOneDatabase(database: DatabaseIdentity, folders: readonly BackupFolder[]): ValidationError {
  return new ValidationError({
    message: `${folders.length} folders in this backup would restore into ${database.binding} (${database.database}): ${folders.map((one) => one.dir).join(", ")}.`,
    action: "Pass the one folder to restore. Nothing was written.",
  });
}

/** The refusal for a backup folder whose binding no Worker in scope binds. */
function notBound(folder: BackupFolder, env: string): NotFoundError {
  return new NotFoundError({
    message: `No database in ${env} is bound to ${folder.migrations.binding} (${folder.migrations.database}).`,
    action: `Bind ${folder.migrations.binding} in the Worker that composes it, or restore with --binding to skip it.`,
  });
}

/** Whether a capability keeps tables in this database. */
function bindsHere(capability: Capability, binding: string): boolean {
  return Object.values(capability.databases ?? {}).some((spec) => spec.binding === binding);
}

/** Run statements in batches, each opening with the pragma that defers foreign keys to its own end. */
async function execute(d1: D1Database, statements: AsyncIterable<string> | Iterable<string>): Promise<void> {
  let batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await d1.batch([d1.prepare("PRAGMA defer_foreign_keys = on"), ...batch.map((one) => d1.prepare(one))]);
    batch = [];
  };
  for await (const statement of statements) {
    batch.push(statement);
    if (batch.length >= 20) await flush();
  }
  await flush();
}

/** Restore one database whose checks all passed. */
async function restoreDatabase(
  folder: BackupFolder,
  database: ProjectDatabase,
  d1: D1Database,
  options: RestoreOptions & { group: string; events: CliAuditEvent[] },
): Promise<DatabaseRestore> {
  const target = { binding: database.binding, database: database.database };
  await claimMigrationOwnership(d1, { project: options.project, binding: database.binding });
  const migrated = await runMigrations(d1, database.provider, target, { group: options.group });

  const schema = parseSchemaSql(await readFile(join(folder.dir, "schema.sql"), "utf8"));
  for (const statement of schema.filter((one) => one.phase === "before")) await d1.prepare(statement.sql).run();

  // Every trigger the migrations made comes down for the load and goes back after it, so no row fires one.
  const triggers = (await readObjects(d1)).filter((row) => row.type === "trigger" && row.sql !== null);
  for (const trigger of triggers) await d1.prepare(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`).run();

  // A migration may seed rows of its own; the backup's rows are the database's, so they replace them.
  for (const table of folder.manifest.tables) await d1.prepare(`DELETE FROM ${quoteIdentifier(table.name)}`).run();

  const prefixes: string[] = [];
  for (const table of folder.manifest.tables) {
    const columns = await readColumns(d1, table.name);
    prefixes.push(
      insertPrefix(
        table.name,
        columns.map((column) => column.name),
      ),
    );
  }
  const lines = createInterface({ input: createReadStream(join(folder.dir, "data.sql")), crlfDelay: Infinity });
  await execute(d1, loadStatements(lines, prefixes));

  for (const trigger of triggers) await d1.prepare(trigger.sql as string).run();
  for (const statement of schema.filter((one) => one.phase === "after")) await d1.prepare(statement.sql).run();

  const rebuilt = await rebuildIndexes(folder, database, d1, options);
  return {
    binding: database.binding,
    database: database.database,
    target: database.target,
    migrations: migrated.length,
    tables: folder.manifest.tables.length,
    rows: folder.manifest.tables.reduce((sum, table) => sum + table.rows, 0),
    rebuilt,
  };
}

/**
 * Bring back what the backup left out. Support's index goes through `provisionSearchIndex`, the code `pithy
 * support provision` runs, which makes the table and its triggers and backfills from the messages. Every
 * other virtual table is made again, empty, from its recorded statement, with the recorded triggers that
 * write into it — only its owner knows how to refill it, so it is named.
 */
async function rebuildIndexes(
  folder: BackupFolder,
  database: ProjectDatabase,
  d1: D1Database,
  options: RestoreOptions & { events: CliAuditEvent[] },
): Promise<RebuiltIndex[]> {
  const rebuilt: RebuiltIndex[] = [];
  const handled = new Set<string>();
  const support = database.capabilities.find(
    (capability) => capability.name === "support" && bindsHere(capability, database.binding),
  );
  if (support !== undefined) {
    const wanted = (support as { supportConfig?: { search?: { fts?: boolean } } }).supportConfig?.search?.fts === true;
    const { table, action } = await (options.searchIndex ?? supportSearchIndex)(options.projectDir, d1, wanted);
    handled.add(table);
    if (action === "create" || action === "repair") {
      rebuilt.push({ name: table, how: "provisioned" });
      // The event `pithy support provision` records for the same call.
      options.events.push({
        action: action === "repair" ? "support/search_triggers_repaired" : "support/search_index_created",
        outcome: "success",
        severity: "info",
        resourceType: "d1_table",
        resourceId: table,
      });
    }
  }
  const present = new Set((await readObjects(d1)).map((row) => row.name));
  for (const virtual of folder.manifest.virtualTables) {
    if (handled.has(virtual.name) || present.has(virtual.name)) continue;
    await d1.prepare(virtual.sql).run();
    for (const trigger of folder.manifest.skippedTriggers) {
      if (identifiersOf(trigger.sql).has(virtual.name.toLowerCase())) await d1.prepare(trigger.sql).run();
    }
    rebuilt.push({ name: virtual.name, how: "recreated-empty" });
  }
  return rebuilt;
}

/**
 * Restore every database in a backup. Every database is checked before any is written; a refusal names the
 * database and leaves all of them as they were.
 */
export async function runRestore(options: RestoreOptions): Promise<DatabaseRestore[]> {
  let folders = await readBackup(options.input);
  if (options.binding !== undefined) {
    const named = folders.filter((folder) => folder.migrations.binding === options.binding);
    if (named.length === 0) {
      throw new NotFoundError({
        message: `${options.input} holds no backup of ${options.binding}.`,
        action: `Pass one of its bindings. Known: ${folders.map((folder) => folder.migrations.binding).join(", ")}.`,
      });
    }
    folders = named;
  }
  /** The checks that need only the files: one database for `--database`, and every row one D1 can take. */
  const checkFiles = (): void => {
    if (options.recovery && folders.length > 1) {
      throw new ValidationError({
        message: "--database restores one database, and this backup holds several.",
        action: `Pass --binding with one of ${folders.map((folder) => folder.migrations.binding).join(", ")}.`,
      });
    }
    for (const folder of folders) if (!folder.manifest.restorable) throw notRestorable(folder);
  };
  // Without --worker every folder must be restored, so the files are checked before anything is resolved.
  // With it, the folders are first narrowed to that Worker's databases, which are known only in beforeOpen.
  if (options.worker === undefined) checkFiles();

  // Each folder's binding and migrations are checked before the recovery database is found or created, and
  // before any database is opened: they need only what migrates into it, so a refusal here creates nothing.
  let recovery: string | undefined;
  const target = new Map<BackupFolder, string>();
  const scope: RestoreOptions = {
    ...options,
    beforeOpen: async (databases) => {
      if (options.worker !== undefined) {
        // --worker restores the databases that Worker binds, out of a backup of them all.
        const bound = folders.filter((folder) => databases.some((one) => isFolderOf(folder, one)));
        if (bound.length === 0) {
          throw new NotFoundError({
            message: `${options.input} holds no backup of a database ${options.worker} binds.`,
            action: `Pass the Worker that binds one of ${folders.map((folder) => `${folder.migrations.binding} (${folder.migrations.database})`).join(", ")}.`,
          });
        }
        folders = bound;
        checkFiles();
      }
      for (const folder of folders) {
        const matches = databases.filter((one) => isFolderOf(folder, one));
        const [database] = matches;
        if (database === undefined) throw notBound(folder, options.env);
        if (matches.length > 1) throw ambiguous(folder, matches);
        const others = folders.filter((other) => other !== folder && target.get(other) === identityKey(database));
        if (others.length > 0) throw twoFoldersOneDatabase(database, [...others, folder]);
        target.set(folder, identityKey(database));
        startStep(`Checking ${database.binding} (${database.database})`);
        await assertSameMigrations(folder, database, options.kitVersion);
      }
      if (options.recovery !== undefined) recovery = await options.recovery();
    },
    retarget: (database) => ([...target.values()].includes(identityKey(database)) ? recovery : undefined),
  };
  return withProjectDatabases(scope, async (opened) => {
    const pairs = folders.map((folder) => {
      const entry = opened.find((one) => identityKey(one.database) === target.get(folder));
      if (entry === undefined) throw notBound(folder, options.env);
      return { folder, ...entry };
    });
    for (const pair of pairs) await assertEmpty(pair.database, pair.d1);
    const group = options.group ?? generatedMigrationGroup();
    const restored: DatabaseRestore[] = [];
    const events: CliAuditEvent[] = [];
    for (const pair of pairs) {
      startStep(`Restoring ${pair.database.binding} (${pair.database.target})`);
      restored.push(await restoreDatabase(pair.folder, pair.database, pair.d1, { ...options, group, events }));
    }
    const audit = options.audit ?? (async () => {});
    for (const event of events) await audit(event);
    await audit({
      action: "restore/loaded",
      outcome: "success",
      severity: options.env === "dev" ? "warning" : "critical",
      resourceType: "environment",
      resourceId: options.env,
      metadata: {
        databases: restored.map((one) => ({
          binding: one.binding,
          database: one.database,
          target: one.target,
          tables: one.tables,
          rows: one.rows,
        })),
        recovery: recovery ?? null,
      },
    });
    return restored;
  });
}
