// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { d1SeedGroup, defineSeed, type SeedSet } from "./seed";
import { collectSeededRows } from "./seededRows";

const Row = z.object({ id: z.string().describe("The row id."), email: z.string().describe("The row email.") });

/** A set declaring one table's rows — the shape every capability's example set has. */
function rowSet(name: string, table: string, rows: readonly z.output<typeof Row>[]): SeedSet {
  return defineSeed({
    name,
    order: 100,
    environments: ["dev"],
    d1: [d1SeedGroup("app", table, Row, rows)],
  });
}

describe("collectSeededRows", () => {
  test("answers with the rows a set declares for a table", () => {
    const seeded = collectSeededRows([rowSet("example", "users", [{ id: "ada", email: "ada@example.com" }])]);
    expect(seeded("app", "users")).toEqual([{ id: "ada", email: "ada@example.com" }]);
  });

  test("merges every set's rows for one table, so one lookup sees the whole run", () => {
    const seeded = collectSeededRows([
      rowSet("example", "users", [{ id: "ada", email: "ada@example.com" }]),
      rowSet("app", "users", [{ id: "jim", email: "jim@pithy.sh" }]),
    ]);
    expect(seeded("app", "users")).toEqual([
      { id: "ada", email: "ada@example.com" },
      { id: "jim", email: "jim@pithy.sh" },
    ]);
  });

  test("keeps tables and databases apart", () => {
    const seeded = collectSeededRows([
      rowSet("users", "users", [{ id: "ada", email: "ada@example.com" }]),
      rowSet("sessions", "sessions", [{ id: "s1", email: "irrelevant" }]),
    ]);
    expect(seeded("app", "users")).toHaveLength(1);
    expect(seeded("analytics", "users")).toEqual([]);
  });

  test("answers empty for a table nothing seeds, rather than undefined", () => {
    expect(collectSeededRows([])("app", "users")).toEqual([]);
  });

  test("reports only what the run will actually write — a prepared set's rows are not knowable yet", () => {
    const prepared = defineSeed({
      name: "prepared",
      order: 110,
      environments: ["dev"],
      prepare: async () => ({ d1: [d1SeedGroup("app", "users", Row, [{ id: "late", email: "late@example.com" }])] }),
    });
    expect(collectSeededRows([prepared])("app", "users")).toEqual([]);
  });
});
