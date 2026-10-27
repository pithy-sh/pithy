// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { identifiersOf, leftOutReason, type MasterRow, planBackup, referenceOrder, type TableListRow } from "./schema";

/** A database holding support's index, an adopter's FTS5 table under no kit pattern, and an adopter table. */
const MASTER: MasterRow[] = [
  {
    type: "table",
    name: "pithy_support_messages",
    tbl_name: "pithy_support_messages",
    sql: "CREATE TABLE pithy_support_messages (id text)",
  },
  {
    type: "table",
    name: "pithy_support_search",
    tbl_name: "pithy_support_search",
    sql: "CREATE VIRTUAL TABLE pithy_support_search USING fts5(a)",
  },
  {
    type: "table",
    name: "pithy_support_search_data",
    tbl_name: "pithy_support_search_data",
    sql: "CREATE TABLE 'pithy_support_search_data'(id INTEGER PRIMARY KEY, block BLOB)",
  },
  {
    type: "table",
    name: "notes_index",
    tbl_name: "notes_index",
    sql: "CREATE VIRTUAL TABLE notes_index USING fts5(body)",
  },
  {
    type: "table",
    name: "notes_index_idx",
    tbl_name: "notes_index_idx",
    sql: "CREATE TABLE 'notes_index_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
  },
  { type: "table", name: "notes", tbl_name: "notes", sql: "CREATE TABLE notes (id integer primary key, body text)" },
  { type: "index", name: "notes_body", tbl_name: "notes", sql: "CREATE INDEX notes_body ON notes(body)" },
  {
    type: "trigger",
    name: "notes_ai",
    tbl_name: "notes",
    sql: 'CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO "notes_index"(body) VALUES (NEW.body); END',
  },
  {
    type: "trigger",
    name: "notes_audit",
    tbl_name: "notes",
    sql: "CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO notes_log(note) VALUES ('notes_index'); END",
  },
  { type: "table", name: "notes_log", tbl_name: "notes_log", sql: "CREATE TABLE notes_log (note text)" },
  {
    type: "trigger",
    name: "pithy_support_search_ai",
    tbl_name: "pithy_support_messages",
    sql: "CREATE TRIGGER pithy_support_search_ai AFTER INSERT ON pithy_support_messages BEGIN DELETE FROM pithy_support_search WHERE message_id = NEW.id; END",
  },
  { type: "table", name: "_cf_KV", tbl_name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key text)" },
  {
    type: "table",
    name: "sqlite_sequence",
    tbl_name: "sqlite_sequence",
    sql: "CREATE TABLE sqlite_sequence(name,seq)",
  },
  {
    type: "table",
    name: "pithy_migrations",
    tbl_name: "pithy_migrations",
    sql: "CREATE TABLE pithy_migrations (name text)",
  },
  { type: "index", name: "sqlite_autoindex_x", tbl_name: "notes", sql: null },
];

const TABLE_LIST: TableListRow[] = [
  { name: "pithy_support_search", type: "virtual" },
  { name: "pithy_support_search_data", type: "shadow" },
  { name: "notes_index", type: "virtual" },
  { name: "notes_index_idx", type: "shadow" },
];

const plan = planBackup({
  master: MASTER,
  tableList: TABLE_LIST,
  owned: new Set(["pithy_support_messages", "pithy_migrations"]),
  references: new Map(),
});

describe("planBackup", () => {
  test("keeps the rows of every ordinary table, kit and adopter alike, and nothing else", () => {
    expect(plan.data.sort()).toEqual(["notes", "notes_log", "pithy_support_messages"]);
  });

  test("leaves out virtual and shadow tables by what SQLite says they are, not by their names", () => {
    expect(plan.leftOut).toEqual(
      expect.arrayContaining([
        { name: "pithy_support_search", reason: "virtual" },
        { name: "pithy_support_search_data", reason: "shadow" },
        { name: "notes_index", reason: "virtual" },
        { name: "notes_index_idx", reason: "shadow" },
        { name: "_cf_KV", reason: "cloudflare" },
        { name: "sqlite_sequence", reason: "sqlite" },
        { name: "pithy_migrations", reason: "bookkeeping" },
      ]),
    );
    expect(plan.virtual.map((entry) => entry.name)).toEqual(["pithy_support_search", "notes_index"]);
    expect(plan.virtual[1]?.sql).toBe("CREATE VIRTUAL TABLE notes_index USING fts5(body)");
  });

  test("leaves out every trigger that names a virtual table, and keeps one that only quotes its name", () => {
    expect(plan.skippedTriggers.map((entry) => entry.name).sort()).toEqual(["notes_ai", "pithy_support_search_ai"]);
    expect(plan.unownedAfter.map((entry) => entry.name)).toEqual(["notes_body", "notes_audit"]);
  });

  test("schema.sql carries only what no migration made", () => {
    expect(plan.unownedTables.map((entry) => entry.name).sort()).toEqual(["notes", "notes_log"]);
  });
});

describe("referenceOrder", () => {
  test("puts a parent before every table that references it", () => {
    const order = referenceOrder(
      ["a_child", "b_grandchild", "z_parent"],
      new Map([
        ["a_child", ["z_parent"]],
        ["b_grandchild", ["a_child"]],
      ]),
    );
    expect(order).toEqual(["z_parent", "a_child", "b_grandchild"]);
  });

  test("ignores a self-reference and breaks a cycle by name rather than looping", () => {
    expect(referenceOrder(["tree"], new Map([["tree", ["tree"]]]))).toEqual(["tree"]);
    expect(
      referenceOrder(
        ["b", "a"],
        new Map([
          ["a", ["b"]],
          ["b", ["a"]],
        ]),
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("identifiersOf", () => {
  test("reads bare and quoted identifiers and skips string literals", () => {
    expect([...identifiersOf(`INSERT INTO "Odd ""Name""" (a) VALUES ('ignored'), [b], \`c\``)]).toEqual(
      expect.arrayContaining(['odd "name"', "a", "b", "c"]),
    );
    expect(identifiersOf("SELECT 'ignored'").has("ignored")).toBe(false);
  });
});

describe("leftOutReason", () => {
  test("keeps an ordinary table", () => {
    expect(leftOutReason("things", "table")).toBeNull();
  });
});
