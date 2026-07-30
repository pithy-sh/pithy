// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate } from "../data/codecs";
import { createDatabase } from "../data/db";
import { PithyError } from "../error/pithyError";
import type { D1SeedGroup } from "./seed";
import { seedD1Group } from "./writeD1";

// A text id so re-running `INSERT OR IGNORE` collides on the primary key (proving idempotency).
const Widget = z
  .object({
    id: z.string().describe("Widget id (text PK)."),
    label: z.string().describe("Display label."),
    active: SQLiteBoolean.describe("Whether active (0|1 in D1)."),
    createdAt: SQLiteDate.describe("Created time (ms-epoch in D1)."),
  })
  .describe("A widget row for the seed writer test.");

const schema = { widgets: Widget };

function database() {
  return createDatabase(env.DB, schema);
}

async function widgetCount(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from widgets").first<{ n: number }>();
  return row?.n ?? 0;
}

const at = new Date(1_700_000_000_000);
const group: D1SeedGroup = {
  database: "app",
  table: "widgets",
  rows: [
    { id: "a", label: "Alpha", active: true, createdAt: at },
    { id: "b", label: "Beta", active: false, createdAt: at },
  ],
};

beforeEach(async () => {
  const db = database();
  await db.schema.dropTable("widgets").ifExists().execute();
  // snake_case physical columns; the writer's Kysely carries CamelCasePlugin.
  await sql`
    create table widgets (
      id text primary key,
      label text not null,
      active integer not null,
      created_at integer not null
    )
  `.execute(db);
});

describe("seedD1Group", () => {
  test("encodes app-shape rows and writes them through Kysely + CamelCasePlugin", async () => {
    const result = await seedD1Group(database(), group, Widget);
    expect(result).toEqual({ table: "widgets", rows: 2 });
    expect(await widgetCount()).toBe(2);

    // Codecs landed: boolean → 0|1, date → ms-epoch, camelCase → snake_case.
    const raw = await env.DB.prepare("select active, created_at from widgets where id = 'a'").first<{
      active: number;
      created_at: number;
    }>();
    expect(raw).toEqual({ active: 1, created_at: at.getTime() });
  });

  test("is idempotent — re-running writes no duplicate rows (INSERT OR IGNORE)", async () => {
    await seedD1Group(database(), group, Widget);
    await seedD1Group(database(), group, Widget);
    expect(await widgetCount()).toBe(2);
  });

  test("dryRun validates and counts but writes nothing", async () => {
    const result = await seedD1Group(database(), group, Widget, { dryRun: true });
    expect(result).toEqual({ table: "widgets", rows: 2 });
    expect(await widgetCount()).toBe(0);
  });

  test("an invalid fixture throws a ValidationError before any write for the group", async () => {
    const badGroup = {
      database: "app",
      table: "widgets",
      rows: [
        { id: "a", label: "Alpha", active: true, createdAt: at },
        { id: "c", label: "Bad", active: "not-a-bool", createdAt: at },
      ],
    } as unknown as D1SeedGroup;

    await expect(seedD1Group(database(), badGroup, Widget)).rejects.toBeInstanceOf(PithyError);
    // Fail-before-write: not even the valid first row landed.
    expect(await widgetCount()).toBe(0);
  });
});
