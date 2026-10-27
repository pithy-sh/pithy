// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  MIGRATION_GROUP_TABLE,
  MIGRATION_LOCK_TABLE,
  MIGRATION_OWNER_TABLE,
  MIGRATION_TABLE,
} from "@pithy-sh/core/src/migrations/bookkeeping";

/**
 * **What a backup takes from a database, and what it leaves out — decided from the schema (#848).**
 *
 * Pure: it reads rows of `sqlite_master` and `PRAGMA table_list` that `./inspect` fetched, and the names a
 * fresh migration creates (`./owned`), and decides. Nothing here matches a name pattern a kit table
 * happens to follow, because the failure that pattern invites is specific: support's FTS5 table is
 * `pithy_support_search`, its shadow tables are ordinary tables named `pithy_support_search_data` and so
 * on, and a filter on `pithy_support_*` exports them. So a virtual table is one SQLite says is virtual, a
 * shadow table is one SQLite says is a shadow, and a trigger is left out when its own SQL names one of
 * them — whatever any of them is called.
 */

/** One `sqlite_master` row, as `./inspect` reads it. */
export interface MasterRow {
  /** `table`, `index`, `trigger` or `view`. */
  type: string;
  /** The object's name. */
  name: string;
  /** The table it belongs to: itself for a table, the indexed or triggering table otherwise. */
  tbl_name: string;
  /** Its `CREATE` statement. `null` for an index SQLite made itself. */
  sql: string | null;
}

/** One `PRAGMA table_list` row in the `main` schema: SQLite's own word on what kind of table it is. */
export interface TableListRow {
  /** The table's name. */
  name: string;
  /** `table`, `view`, `virtual` or `shadow`. */
  type: string;
}

/** Why a table is left out of `data.sql`. */
export type LeftOutReason = "virtual" | "shadow" | "cloudflare" | "sqlite" | "bookkeeping";

/** Migrate's own tables. It writes them on every run, so a backup never carries their rows (#848). */
export const BOOKKEEPING_TABLES: ReadonlySet<string> = new Set([
  MIGRATION_TABLE,
  MIGRATION_LOCK_TABLE,
  MIGRATION_OWNER_TABLE,
  MIGRATION_GROUP_TABLE,
]);

/** A statement the backup records for later: an object's name and the SQL that makes it. */
export interface Statement {
  /** `table`, `view`, `index` or `trigger`. */
  type: string;
  /** The object's name. */
  name: string;
  /** The table it belongs to. */
  table: string;
  /** Its `CREATE` statement. */
  sql: string;
}

/** What one database's backup is made of. */
export interface BackupPlan {
  /** Every table whose rows go into `data.sql`, parents before the tables that reference them. */
  data: string[];
  /** Every table left out, and why. */
  leftOut: Array<{ name: string; reason: LeftOutReason }>;
  /** Every virtual table left out, with the statement that recreates it. */
  virtual: Array<{ name: string; sql: string }>;
  /** Every trigger left out because its SQL names a virtual or shadow table. */
  skippedTriggers: Statement[];
  /** Tables and views no migration makes — `schema.sql`'s first half, made before the rows load. */
  unownedTables: Statement[];
  /** Indexes and triggers no migration makes — `schema.sql`'s second half, made after the rows load. */
  unownedAfter: Statement[];
}

/** Why a table is left out, or `null` when its rows are kept. */
export function leftOutReason(name: string, type: string): LeftOutReason | null {
  if (type === "virtual") return "virtual";
  if (type === "shadow") return "shadow";
  if (name.startsWith("_cf_")) return "cloudflare";
  if (name.toLowerCase().startsWith("sqlite_")) return "sqlite";
  if (BOOKKEEPING_TABLES.has(name)) return "bookkeeping";
  return null;
}

/**
 * Every identifier a statement mentions, lowercased — quoted (`"x"`, `` `x` ``, `[x]`) or bare. String
 * literals are skipped, so a trigger that writes the word `pithy_support_search` into a column does not
 * read as one that writes into the table.
 */
export function identifiersOf(sql: string): Set<string> {
  const found = new Set<string>();
  const pattern = /'(?:[^']|'')*'|"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/``/g, "`") ?? match[3] ?? match[4];
    if (name !== undefined) found.add(name.toLowerCase());
  }
  return found;
}

/**
 * Order tables so every table comes after the tables it references, which is what lets a restore load
 * rows with foreign keys enforced. A self-reference is no constraint on the order; a cycle is broken by
 * name, and its rows rely on the multi-row statement each table loads in. Ties go by name, so the same
 * schema always dumps in the same order.
 */
export function referenceOrder(
  tables: readonly string[],
  references: ReadonlyMap<string, readonly string[]>,
): string[] {
  const pending = new Set([...tables].sort());
  const ordered: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].find((table) =>
      (references.get(table) ?? []).every((parent) => parent === table || !pending.has(parent)),
    );
    const next = ready ?? [...pending][0];
    if (next === undefined) break;
    ordered.push(next);
    pending.delete(next);
  }
  return ordered;
}

/**
 * Decide one database's backup from its schema. `owned` is every name a fresh migration of the same
 * migrations creates; anything else in `sqlite_master` was made some other way, and goes into
 * `schema.sql` so a restore can make it again.
 */
export function planBackup(input: {
  master: readonly MasterRow[];
  tableList: readonly TableListRow[];
  owned: ReadonlySet<string>;
  references: ReadonlyMap<string, readonly string[]>;
}): BackupPlan {
  const kinds = new Map(input.tableList.map((row) => [row.name, row.type]));
  const leftOut: BackupPlan["leftOut"] = [];
  const virtual: BackupPlan["virtual"] = [];
  const kept: string[] = [];
  for (const row of input.master.filter((one) => one.type === "table")) {
    const reason = leftOutReason(row.name, kinds.get(row.name) ?? "table");
    if (reason === null) {
      kept.push(row.name);
      continue;
    }
    leftOut.push({ name: row.name, reason });
    if (reason === "virtual" && row.sql !== null) virtual.push({ name: row.name, sql: row.sql });
  }
  const excluded = new Set(leftOut.map((entry) => entry.name.toLowerCase()));
  const indexing = new Set(
    leftOut.filter((entry) => entry.reason === "virtual" || entry.reason === "shadow").map((e) => e.name.toLowerCase()),
  );

  const skippedTriggers: Statement[] = [];
  const unownedTables: Statement[] = [];
  const unownedAfter: Statement[] = [];
  for (const row of input.master) {
    if (row.sql === null || row.name.toLowerCase().startsWith("sqlite_")) continue;
    const statement = { type: row.type, name: row.name, table: row.tbl_name, sql: row.sql };
    if (row.type === "trigger") {
      const names = identifiersOf(row.sql);
      names.delete(row.name.toLowerCase());
      if ([...names].some((name) => indexing.has(name))) {
        skippedTriggers.push(statement);
        continue;
      }
    }
    if (input.owned.has(row.name)) continue;
    if (excluded.has(row.tbl_name.toLowerCase())) continue;
    if (row.type === "table" || row.type === "view") unownedTables.push(statement);
    else unownedAfter.push(statement);
  }
  // Tables before views, which may select from them.
  unownedTables.sort((a, b) => (a.type === b.type ? 0 : a.type === "table" ? -1 : 1));
  // Indexes before triggers, so a trigger never fires against a table still being indexed.
  unownedAfter.sort((a, b) => (a.type === b.type ? 0 : a.type === "index" ? -1 : 1));

  return {
    data: referenceOrder(kept, input.references),
    leftOut,
    virtual,
    skippedTriggers,
    unownedTables,
    unownedAfter,
  };
}
