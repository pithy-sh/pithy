// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { type ExtraMigrations, prepareScopedBackend } from "./scopedBackend";

/**
 * **The drop step of `prepareScopedBackend`, against real D1 with foreign keys on.**
 *
 * Each schema arrives the way an adopter's would, as the app's own migrations through `extra`. A schema that
 * should reset is reset three times with rows in every table between resets, as a suite's `beforeEach` would.
 */

/** One app capability's migrations, in the order they were written. */
function app(...steps: readonly (readonly string[])[]): ExtraMigrations[] {
  const migrations: Record<string, Migration> = {};
  steps.forEach((statements, index) => {
    migrations[`000${index + 1}_step`] = {
      up: async (db) => {
        for (const statement of statements) await sql.raw(statement).execute(db);
      },
    };
  });
  return [{ namespace: "app", order: 9000, migrations }];
}

async function run(statements: readonly string[]): Promise<void> {
  for (const statement of statements) await env.DB.prepare(statement).run();
}

async function rowCount(table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from "${table.replaceAll('"', '""')}"`).first<{ n: number }>();
  return row?.n ?? -1;
}

/** Reset, fill every table, and reset again, three times over; then every table is there and empty. */
async function resetsRepeatedly(extra: ExtraMigrations[], rows: readonly string[], tables: readonly string[]) {
  for (let call = 0; call < 3; call++) {
    await prepareScopedBackend(env, extra);
    for (const table of tables) expect(await rowCount(table)).toBe(0);
    await run(rows);
  }
}

describe("prepareScopedBackend drops an app's tables children first", () => {
  test("a table that references two others resets on the second and third call", async () => {
    const extra = app([
      "create table parent_a (id text primary key)",
      "create table parent_b (id text primary key)",
      `create table child (
        id text primary key,
        a_id text not null references parent_a(id) on delete cascade,
        b_id text not null references parent_b(id) on delete cascade
      )`,
    ]);
    await resetsRepeatedly(
      extra,
      [
        "insert into parent_a values ('a')",
        "insert into parent_b values ('b')",
        "insert into child values ('c', 'a', 'b')",
      ],
      ["parent_a", "parent_b", "child"],
    );
  });

  test("a self-referencing table beside another parent resets", async () => {
    const extra = app([
      "create table owner (id text primary key)",
      `create table category (
        id text primary key,
        owner_id text not null references owner(id) on delete cascade,
        merged_into_id text references category(id) on delete cascade
      )`,
    ]);
    await resetsRepeatedly(
      extra,
      [
        "insert into owner values ('o')",
        "insert into category values ('kept', 'o', null)",
        "insert into category values ('merged', 'o', 'kept')",
      ],
      ["owner", "category"],
    );
  });

  // `post` is created first and only later references two newer tables, and `review` references `post` and
  // one of them. Dropping in creation order fails at `author`, and dropping newest first fails there too.
  const LATE_REFERENCE = app(
    ["create table post (id text primary key)"],
    [
      "create table author (id text primary key)",
      "create table topic (id text primary key)",
      "alter table post add column author_id text references author(id) on delete cascade",
      "alter table post add column topic_id text references topic(id) on delete cascade",
      `create table review (
        id text primary key,
        post_id text not null references post(id) on delete cascade,
        author_id text not null references author(id) on delete cascade
      )`,
    ],
  );
  const LATE_REFERENCE_TABLES = ["post", "author", "topic", "review"];
  const LATE_REFERENCE_ROWS = [
    "insert into author values ('a')",
    "insert into topic values ('t')",
    "insert into post values ('p', 'a', 't')",
    "insert into review values ('r', 'p', 'a')",
  ];

  test("a table that a later migration made reference newer tables resets", async () => {
    await resetsRepeatedly(LATE_REFERENCE, LATE_REFERENCE_ROWS, LATE_REFERENCE_TABLES);
  });

  test("on that schema, dropping newest first fails, so reversing creation order is no fix", async () => {
    await prepareScopedBackend(env, LATE_REFERENCE);
    await run(LATE_REFERENCE_ROWS);
    await expect(run([...LATE_REFERENCE_TABLES].reverse().map((table) => `drop table ${table}`))).rejects.toThrow(
      /no such table: main\.topic/,
    );
  });

  test("a two-table cycle with rows in both resets", async () => {
    const extra = app([
      "create table ring_a (id text primary key, b_id text references ring_b(id))",
      "create table ring_b (id text primary key, a_id text references ring_a(id))",
    ]);
    await resetsRepeatedly(
      extra,
      ["insert into ring_a values ('a', null)", "insert into ring_b values ('b', 'a')", "update ring_a set b_id = 'b'"],
      ["ring_a", "ring_b"],
    );
  });

  test("a reference spelled in another case than the table it names resets", async () => {
    const extra = app([
      "create table parent_a (id text primary key)",
      "create table parent_b (id text primary key)",
      `create table child (
        id text primary key,
        a_id text not null references PARENT_A(id) on delete cascade,
        b_id text not null references Parent_B(id) on delete cascade
      )`,
    ]);
    await resetsRepeatedly(
      extra,
      [
        "insert into parent_a values ('a')",
        "insert into parent_b values ('b')",
        "insert into child values ('c', 'a', 'b')",
      ],
      ["parent_a", "parent_b", "child"],
    );
  });

  test("a cycle of set null keys with rows in every table resets", async () => {
    const extra = app([
      "create table null_p (id text primary key, q_id text references null_q(id) on delete set null, r_id text references null_r(id) on delete set null)",
      "create table null_q (id text primary key, p_id text references null_p(id) on delete set null, r_id text references null_r(id) on delete set null)",
      "create table null_r (id text primary key, p_id text references null_p(id) on delete set null, q_id text references null_q(id) on delete set null)",
    ]);
    await resetsRepeatedly(
      extra,
      [
        "insert into null_p values ('p', null, null)",
        "insert into null_q values ('q', 'p', null)",
        "insert into null_r values ('r', 'p', 'q')",
        "update null_p set q_id = 'q', r_id = 'r'",
        "update null_q set r_id = 'r'",
      ],
      ["null_p", "null_q", "null_r"],
    );
  });

  test("a table whose name holds a double quote resets", async () => {
    const extra = app([
      'create table "say ""hi""" (id text primary key)',
      'create table reply (id text primary key, to_id text references "say ""hi"""(id) on delete cascade)',
    ]);
    await resetsRepeatedly(
      extra,
      ['insert into "say ""hi""" values (\'s\')', "insert into reply values ('r', 's')"],
      ['say "hi"', "reply"],
    );
  });

  // Last in the file: once these tables exist, no order of drops removes them.
  test("a cycle that no order can drop is refused, naming its tables", async () => {
    const extra = app([
      "create table mesh_p (id text primary key, q_id text references mesh_q(id) on delete cascade, r_id text references mesh_r(id) on delete cascade)",
      "create table mesh_q (id text primary key, p_id text references mesh_p(id) on delete cascade, r_id text references mesh_r(id) on delete cascade)",
      "create table mesh_r (id text primary key, p_id text references mesh_p(id) on delete cascade, q_id text references mesh_q(id) on delete cascade)",
    ]);
    await prepareScopedBackend(env, extra);
    await expect(prepareScopedBackend(env, extra)).rejects.toThrow(/"mesh_p", "mesh_q", "mesh_r"/);
    // The refusal comes before the first drop, so every table is still there.
    for (const table of ["mesh_p", "mesh_q", "mesh_r", "pithy_auth_users"]) expect(await rowCount(table)).toBe(0);
  });
});
