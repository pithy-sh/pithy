// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate } from "./codecs";
import { createDatabase } from "./db";

// One Zod schema is the whole table definition. `z.output` is the app shape;
// `z.input` is the SQLite row shape, used by Kysely. Booleans and dates go
// through codecs (0|1 and ms-epoch on the row side).
const User = z
  .object({
    id: z.number().describe("Auto-incrementing primary key."),
    email: z.string().describe("Login email."),
    isActive: SQLiteBoolean.describe("Whether the account is active (0|1 in D1)."),
    createdAt: SQLiteDate.describe("Account creation time (ms-epoch in D1)."),
  })
  .describe("A user row for the database round-trip test.");
type User = z.output<typeof User>;

const schema = { users: User };

function database() {
  return createDatabase(env.DB, schema);
}

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("users").ifExists().execute();
  // Physical columns are snake_case; the round-trip below uses camelCase keys,
  // so success proves CamelCasePlugin bridges the two.
  await sql`
    create table users (
      id integer primary key autoincrement,
      email text not null,
      is_active integer not null,
      created_at integer not null
    )
  `.execute(db);
});

describe("createDatabase", () => {
  test("round-trips an app object through codecs + Kysely + CamelCasePlugin", async () => {
    const db = database();
    const createdAt = new Date(1_700_000_000_000);

    // Encode via codecs, insert with camelCase keys (no id — D1 generates it).
    await db
      .insertInto("users")
      .values({
        email: "a@b.com",
        isActive: SQLiteBoolean.encode(true),
        createdAt: SQLiteDate.encode(createdAt),
      })
      .execute();

    // Read the raw row back (camelCase keys, via the plugin) and decode it.
    const row = await db.selectFrom("users").selectAll().executeTakeFirstOrThrow();
    const user: User = User.parse(row);

    expect(typeof user.id).toBe("number");
    expect(user.id).toBeGreaterThan(0);
    expect(user.email).toBe("a@b.com");
    expect(user.isActive).toBe(true);
    expect(user.createdAt).toEqual(createdAt);
  });

  test("stores booleans as 0|1 and dates as ms-epoch in snake_case columns", async () => {
    const db = database();
    await db
      .insertInto("users")
      .values({ email: "c@d.com", isActive: SQLiteBoolean.encode(false), createdAt: SQLiteDate.encode(new Date(0)) })
      .execute();

    // Inspect physical storage via the raw D1 binding (no CamelCasePlugin), so
    // the real column names and stored values are observed: snake_case columns
    // holding a 0 boolean and a 0 ms-epoch date.
    const raw = await env.DB.prepare("select is_active, created_at from users").first<{
      is_active: number;
      created_at: number;
    }>();
    expect(raw).toEqual({ is_active: 0, created_at: 0 });
  });
});
