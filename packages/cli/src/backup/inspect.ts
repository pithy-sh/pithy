// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { quoteIdentifier } from "./files";
import type { MasterRow, TableListRow } from "./schema";

/**
 * **The reads a backup makes of a database's schema (#848)** — over a `D1Database`, so the same code reads
 * a local Miniflare store and a remote database over `@pithy-sh/cloudflare`'s REST client. Every one is a
 * plain `SELECT` on `sqlite_master` or a `PRAGMA` D1 permits (`table_list`, `table_info`,
 * `foreign_key_list`); none of them writes.
 */

/** `sqlite_master`, and SQLite's own word on each table's kind from `PRAGMA table_list`, `main` schema only. */
export async function readSchema(
  d1: D1Database,
): Promise<{ master: MasterRow[]; tableList: Array<TableListRow & { wr: number }> }> {
  const master = await d1
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
    .all<MasterRow>();
  const listed = await d1.prepare("PRAGMA table_list").all<TableListRow & { wr: number; schema: string }>();
  return {
    master: master.results ?? [],
    tableList: (listed.results ?? [])
      .filter((row) => row.schema === "main")
      .map((row) => ({ name: row.name, type: row.type, wr: row.wr })),
  };
}

/** One table's columns, in order — the ones an `INSERT` can name, so no generated or hidden column. */
export async function readColumns(d1: D1Database, table: string): Promise<Array<{ name: string; pk: number }>> {
  const info = await d1.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<{ name: string; pk: number }>();
  return (info.results ?? []).map((row) => ({ name: row.name, pk: row.pk }));
}

/** The tables each table references through a foreign key. */
export async function readReferences(d1: D1Database, tables: readonly string[]): Promise<Map<string, string[]>> {
  const references = new Map<string, string[]>();
  for (const table of tables) {
    const keys = await d1.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all<{ table: string }>();
    references.set(table, [...new Set((keys.results ?? []).map((row) => row.table))]);
  }
  return references;
}

/** How many rows a table holds. */
export async function countRows(d1: D1Database, table: string): Promise<number> {
  const row = await d1.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Every table, view, index and trigger in the database that SQLite or Cloudflare did not make. */
export async function readObjects(d1: D1Database): Promise<Array<{ type: string; name: string; sql: string | null }>> {
  const rows = await d1
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid")
    .all<{ type: string; name: string; sql: string | null }>();
  return (rows.results ?? []).filter((row) => !row.name.startsWith("_cf_"));
}
