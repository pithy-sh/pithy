// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "./boundParameters";
import { createDatabase } from "./db";

/**
 * **The invariant: no statement this repository executes binds more parameters than D1 accepts.**
 *
 * It is stated here, once, over every statement — not over a list of the query sites that have been
 * caught binding too many. That list has been wrong five times: #246 fixed the seed writer, the sweep it
 * was asked to do found four more, and a fifth appeared in `provision/wranglerEnv.ts` inside a week. A
 * gate naming files goes green the moment somebody writes a sixth.
 *
 * So the measurement is taken where the number is real — `D1PreparedStatement.bind`, what the driver
 * hands the platform after Kysely has compiled and after any chunking — and the enforcement lives at
 * `createDatabase`, the one seam every Kysely instance in this repository comes from. A query site
 * cannot opt out of it, and a query site that has never heard of the cap is still covered.
 */

const Row = z
  .object({
    id: z.string().describe("Row id (text PK)."),
    label: z.string().describe("Display label."),
  })
  .describe("A row for the bound-parameter gate's fixture table.");

const tables = { widgets: Row };

beforeEach(async () => {
  await env.DB.prepare("drop table if exists widgets").run();
  await env.DB.prepare("create table widgets (id text primary key, label text not null)").run();
});

/**
 * The platform's own answer, taken from the runtime rather than from the documentation.
 *
 * Everything downstream is arithmetic against this number, so it is measured rather than trusted. If a
 * future runtime moves the cap, this is the test that says so first.
 */
describe("D1's cap, as the runtime enforces it", () => {
  test("accepts exactly 100 bound parameters and rejects 101", async () => {
    const at = (count: number) =>
      env.DB.prepare(`select 1 where 1 in (${Array.from({ length: count }, () => "?").join(",")})`).bind(
        ...Array.from({ length: count }, () => 1),
      );

    await expect(at(MAX_BOUND_PARAMETERS).all()).resolves.toBeDefined();
    await expect(at(MAX_BOUND_PARAMETERS + 1).all()).rejects.toThrow(/too many SQL variables/i);
  });
});

describe("the gate", () => {
  test("a planted over-bind fails as the rule, not as SQLite's complaint", async () => {
    const db = createDatabase(env.DB, tables);
    // Deliberately unchunked: one id over the cap, which is the exact shape every producer of this
    // defect has had. If this ever passes, the gate has stopped biting.
    const ids = Array.from({ length: MAX_BOUND_PARAMETERS + 1 }, (_, index) => `id-${index}`);

    const failure = await db
      .selectFrom("widgets")
      .selectAll()
      .where("id", "in", ids)
      .execute()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure, "an unchunked list of 101 ids was allowed through").toBeInstanceOf(PithyError);
    const payload = (failure as PithyError).payload;
    expect(payload.code).toBe("core/internal");
    expect(payload.detail).toContain(String(MAX_BOUND_PARAMETERS + 1));
    expect(payload.detail).toContain(String(MAX_BOUND_PARAMETERS));
    // The throw-site context is where D1 is named; the client-safe message never leaks the query.
    expect(payload.message).not.toContain("widgets");
  });

  test("a statement at exactly the cap is allowed — the gate is not over-cautious", async () => {
    const db = createDatabase(env.DB, tables);
    const ids = Array.from({ length: MAX_BOUND_PARAMETERS }, (_, index) => `id-${index}`);

    await expect(db.selectFrom("widgets").selectAll().where("id", "in", ids).execute()).resolves.toEqual([]);
  });

  test("it counts what the driver binds, not what the caller intended", async () => {
    const db = createDatabase(env.DB, tables);
    // Two fixed parameters ahead of the list, which is what makes a chunk of exactly 100 wrong.
    const ids = Array.from({ length: MAX_BOUND_PARAMETERS - 1 }, (_, index) => `id-${index}`);

    const failure = await db
      .updateTable("widgets")
      .set({ label: "claimed" })
      .where("id", "in", ids)
      .where(sql<boolean>`length(label) > ${0}`)
      .execute()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // 99 ids + the `set` + the `length` comparison = 101.
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.detail).toContain("101");
  });
});

describe("recordBoundParameters", () => {
  test("records every count the driver bound, in order", async () => {
    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      const db = createDatabase(d1, tables);
      await db.insertInto("widgets").values({ id: "a", label: "Alpha" }).execute();
      await db.selectFrom("widgets").selectAll().where("id", "in", ["a", "b", "c"]).execute();
    });

    expect(error).toBeUndefined();
    expect(counts).toEqual([2, 3]);
  });

  test("returns the throw rather than propagating it, so a gate asserts the rule first", async () => {
    const over = MAX_BOUND_PARAMETERS + 1;
    // Raw D1, deliberately outside `createDatabase` — the guard would refuse this before the platform
    // ever saw it, and what is being proved here is that the recorder counts what the platform counts.
    const { counts, error } = await recordBoundParameters(env.DB, async (d1) => {
      await d1
        .prepare(`select 1 where 1 in (${Array.from({ length: over }, () => "?").join(",")})`)
        .bind(...Array.from({ length: over }, () => 1))
        .all();
    });

    expect(counts).toEqual([over]);
    expect(String(error)).toMatch(/too many SQL variables/i);
  });
});
