// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MAX_BOUND_PARAMETERS } from "../data/boundParameters";
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

/**
 * A table of `width` text columns named `c0…c<width-1>`, plus a text primary key.
 *
 * Built rather than written out because the property under test is about *arithmetic over the column
 * count*, and a fixed fixture can only ever prove one width. A seven-column table is where the defect
 * was found; it is not where the rule lives.
 */
function wideSchema(width: number): z.ZodObject {
  const shape: Record<string, z.ZodType> = { id: z.string().describe("Row id (text PK).") };
  for (let column = 0; column < width; column++) shape[`c${column}`] = z.string().describe(`Column ${column}.`);
  return z.object(shape).describe("A generated wide row, for proving the bound-parameter ceiling.");
}

async function createWideTable(width: number): Promise<void> {
  const columns = Array.from({ length: width }, (_, column) => `c${column} text not null`).join(", ");
  await env.DB.prepare("drop table if exists wide").run();
  await env.DB.prepare(`create table wide (id text primary key, ${columns})`).run();
}

function wideRows(width: number, count: number): Record<string, string>[] {
  return Array.from({ length: count }, (_, index) => {
    const row: Record<string, string> = { id: `row-${index}` };
    for (let column = 0; column < width; column++) row[`c${column}`] = `v${index}-${column}`;
    return row;
  });
}

async function wideCount(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from wide").first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Every parameter count D1 was actually asked to bind while `run` executed, and whatever `run` threw.
 *
 * Recorded at `D1PreparedStatement.bind`, which is the only place the number is real: it is what the
 * driver hands the platform, after Kysely has compiled the statement and after any chunking. Counting
 * anything earlier would be counting our own intention rather than the thing D1 rejects.
 *
 * The throw is returned rather than propagated so the caller can assert the invariant **first**. A
 * statement over the ceiling fails at the platform with `too many SQL variables`, which names SQLite's
 * complaint rather than the rule that was broken; checking the counts before rethrowing means the
 * failure an author reads is the invariant, and anything else still surfaces intact.
 */
async function recordBindCounts(
  run: (d1: typeof env.DB) => Promise<void>,
): Promise<{ counts: number[]; error: unknown }> {
  const counts: number[] = [];
  const recorder = new Proxy(env.DB, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, key) {
            if (key === "bind") {
              return (...values: unknown[]) => {
                counts.push(values.length);
                return inner.bind(...values);
              };
            }
            const value = Reflect.get(inner, key);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      };
    },
  });
  try {
    await run(recorder);
    return { counts, error: undefined };
  } catch (error) {
    return { counts, error };
  }
}

/**
 * The bound-parameter ceiling.
 *
 * **The invariant: no statement `seedD1Group` executes may bind more parameters than D1 accepts — for
 * any fixture, of any width, of any length.** It is stated over the whole space rather than over a list
 * of known-bad sizes, because the bug was never one size: an insert binds one parameter per column per
 * row, so the ceiling moves with the table and every fixture author would otherwise have to re-derive
 * it. The measurement is taken at the D1 binding, so the assertion holds whatever the writer does
 * internally — chunk, batch, or something later that has not been invented yet.
 *
 * Found in `pithy-sh/dashboard`: every fixture the kit ships is 2–6 rows, and the first realistic one —
 * big enough to page, so necessarily over `DEFAULT_PAGE_SIZE` — died on `too many SQL variables`.
 */
describe("seedD1Group and D1's bound-parameter ceiling", () => {
  test("no statement binds more than D1 accepts, at any width or length", async () => {
    // Widths spanning the divisor, from a two-column table to one that fits a single row per statement.
    for (const width of [1, 6, 7, 24, 99]) {
      await createWideTable(width);
      const columns = width + 1; // the id column binds too
      // Enough rows to need several statements at this width, plus one — so a chunk boundary is
      // crossed, and the last chunk is a partial one.
      const rows = wideRows(width, Math.floor(MAX_BOUND_PARAMETERS / columns) * 3 + 1);
      const schema = wideSchema(width);

      const { counts, error } = await recordBindCounts(async (d1) => {
        await seedD1Group(createDatabase(d1, { wide: schema }), { database: "app", table: "wide", rows }, schema);
      });

      // The invariant, asserted before anything else — including before the platform's own complaint.
      const worst = Math.max(...counts, 0);
      expect(worst, `${width + 1} columns: nothing was ever bound`).toBeGreaterThan(0);
      expect(
        worst,
        `${width + 1} columns: one statement bound ${worst} parameters, over D1's cap of ${MAX_BOUND_PARAMETERS}`,
      ).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
      if (error) throw error;
      // Chunking that loses rows would satisfy the ceiling and be worse than the bug.
      expect(await wideCount()).toBe(rows.length);
    }
  });

  test("a single group of 500 rows across a wide table seeds without error", async () => {
    await createWideTable(6); // seven columns with the id — the shape the defect was found on
    const schema = wideSchema(6);
    const rows = wideRows(6, 500);

    const result = await seedD1Group(
      createDatabase(env.DB, { wide: schema }),
      { database: "app", table: "wide", rows },
      schema,
    );

    expect(result).toEqual({ table: "wide", rows: 500 });
    expect(await wideCount()).toBe(500);
  });

  test("a big group stays idempotent and non-destructive across chunks", async () => {
    await createWideTable(6);
    const schema = wideSchema(6);
    const rows = wideRows(6, 200);
    const db = () => createDatabase(env.DB, { wide: schema });

    await seedD1Group(db(), { database: "app", table: "wide", rows }, schema);
    await seedD1Group(db(), { database: "app", table: "wide", rows }, schema);

    expect(await wideCount()).toBe(200);
  });

  test("an invalid row late in a big group still fails before any chunk is written", async () => {
    await createWideTable(6);
    const schema = wideSchema(6);
    const rows: unknown[] = wideRows(6, 200);
    rows[199] = { ...(rows[199] as Record<string, string>), c0: 42 };

    await expect(
      seedD1Group(
        createDatabase(env.DB, { wide: schema }),
        { database: "app", table: "wide", rows } as unknown as D1SeedGroup,
        schema,
      ),
    ).rejects.toBeInstanceOf(PithyError);
    expect(await wideCount()).toBe(0);
  });
});
