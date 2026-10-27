// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import {
  D1_MAX_STATEMENT_BYTES,
  insertLine,
  insertPrefix,
  loadStatements,
  parseSchemaSql,
  quoteIdentifier,
  renderSchemaSql,
  rowLiteral,
  statementBytes,
} from "./files";

describe("quoteIdentifier", () => {
  test("doubles an embedded quote", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

/** Every statement a generator yields. */
async function collect(statements: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const statement of statements) all.push(statement);
  return all;
}

describe("loadStatements", () => {
  const things = insertPrefix("things", ["id", "name"]);
  const others = insertPrefix("others", ["id"]);

  test("folds consecutive rows of one table into one statement, and keeps tables apart", async () => {
    const lines = [
      "-- a comment",
      "PRAGMA defer_foreign_keys = on;",
      insertLine(things, "1,'a'"),
      insertLine(things, "2,'b'"),
      insertLine(others, "1"),
      "",
    ];
    expect(await collect(loadStatements(lines, [things, others]))).toEqual([
      "PRAGMA defer_foreign_keys = on;",
      `${things}(1,'a'), (2,'b');`,
      `${others}(1);`,
    ]);
  });

  test("never builds a statement D1 would refuse for its size", async () => {
    const big = "x".repeat(30_000);
    const lines = Array.from({ length: 10 }, (_, index) => insertLine(things, `${index},'${big}'`));
    const statements = await collect(loadStatements(lines, [things]));
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.every((statement) => statementBytes(statement) < D1_MAX_STATEMENT_BYTES)).toBe(true);
    expect(statements.join("").match(/'x+'/g)).toHaveLength(10);
  });

  test("caps the rows in one statement", async () => {
    const lines = Array.from({ length: 1201 }, (_, index) => insertLine(things, `${index},'r'`));
    expect(await collect(loadStatements(lines, [things]))).toHaveLength(3);
  });
});

describe("schema.sql", () => {
  test("round-trips every statement through its marker, multi-line triggers included", () => {
    const statements = [
      { phase: "before" as const, type: "table", name: "notes", sql: "CREATE TABLE notes (id integer)" },
      {
        phase: "after" as const,
        type: "trigger",
        name: "notes_ai",
        sql: "CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN\n  INSERT INTO log VALUES (1);\nEND",
      },
    ];
    const text = renderSchemaSql("-- header", statements);
    expect(parseSchemaSql(text)).toEqual(statements);
  });

  test("a schema.sql with no statements reads as none", () => {
    expect(parseSchemaSql(renderSchemaSql("-- header", []))).toEqual([]);
  });
});

/** Run `body` against an empty in-memory D1. */
async function withScratch<T>(body: (db: D1Database) => Promise<T>): Promise<T> {
  const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { D: "scratch" } }),
  );
  try {
    return await body((await mf.getD1Database("D")) as unknown as D1Database);
  } finally {
    await mf.dispose();
  }
}

describe("rowLiteral", () => {
  const columns = ["id", 'we"ird col', "weight", "data", "note"];

  test("reads each value as its exact SQLite literal, one line per row, and the INSERT brings it back", async () => {
    await withScratch(async (db) => {
      const create = (table: string) =>
        `CREATE TABLE ${table} (id integer primary key, "we""ird col" text, weight real, data blob, note text)`;
      await db.batch([
        db.prepare(create("source")),
        db.prepare(create("copy")),
        db.prepare(
          `INSERT INTO source VALUES
            (1, 'it''s', 0.1, x'00ff', 'two' || char(10) || 'lines'),
            (2, NULL, 3.0, NULL, 'carriage' || char(13) || 'only'),
            (3, 'plain', -1.5e-300, x'', NULL),
            (9007199254740993, '', 1e308, NULL, 'crlf' || char(13, 10) || 'here'),
            (10, '~n', 2.5, NULL, '~n~0~' || char(10) || '~r' || char(13) || '~')`,
        ),
      ]);
      const read = await db.prepare(`SELECT ${rowLiteral(columns)} AS v FROM source ORDER BY id`).all<{ v: string }>();
      const literals = read.results.map((row) => row.v);
      // A line break is escaped in place and put back by `replace()`: the size barely grows, so a long reply
      // stays under D1's limit, and three nested calls keep the expression shallow however many lines it has.
      expect(literals[0]).toBe(
        "1,'it''s',0.1,X'00FF',replace(replace(replace('two~nlines', '~n', char(10)), '~r', char(13)), '~0', '~')",
      );
      expect(literals[1]).toBe(
        "2,NULL,3.0,NULL,replace(replace(replace('carriage~ronly', '~n', char(10)), '~r', char(13)), '~0', '~')",
      );
      // A string with no line break is SQLite's own literal, untouched, tildes and all.
      expect(literals[3]).toBe(
        "10,'~n',2.5,NULL,replace(replace(replace('~0n~00~0~n~0r~r~0', '~n', char(10)), '~r', char(13)), '~0', '~')",
      );
      // Every literal stays on one line: no row of data.sql spans two.
      expect(literals.every((literal) => !/[\r\n]/.test(literal))).toBe(true);

      const prefix = insertPrefix("copy", columns);
      for (const literal of literals) await db.prepare(insertLine(prefix, literal)).run();
      const all = async (table: string) =>
        (
          await db
            .prepare(`SELECT *, typeof(weight) AS tw, typeof(data) AS td, typeof(note) AS tn FROM ${table} ORDER BY id`)
            .all()
        ).results;
      expect(await all("copy")).toEqual(await all("source"));
    });
  });
});
