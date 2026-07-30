// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate } from "../data/codecs";
import { d1SeedGroup, defineSeed, kvSeedGroup } from "./seed";

const Widget = z
  .object({
    id: z.string().describe("Widget id."),
    active: SQLiteBoolean.describe("Whether the widget is active."),
    createdAt: SQLiteDate.describe("When it was created."),
  })
  .describe("A widget row fixture.");

describe("d1SeedGroup", () => {
  test("returns a schema-free group of app-shape rows", () => {
    const at = new Date(1_700_000_000_000);
    const group = d1SeedGroup("app", "widgets", Widget, [{ id: "a", active: true, createdAt: at }]);
    expect(group).toEqual({ database: "app", table: "widgets", rows: [{ id: "a", active: true, createdAt: at }] });
    // The schema is a compile-time carrier only — never stored on the group.
    expect("schema" in group).toBe(false);
  });
});

describe("kvSeedGroup", () => {
  test("returns a group of entries for a namespace store", () => {
    const Value = z.object({ url: z.string().describe("Where the bytes live.") }).describe("A KV value fixture.");
    const Key = z.object({ uuid: z.string().describe("The id segment.") }).describe("A KV key fixture.");
    const group = kvSeedGroup("assets", "images", { prefix: "assets", key: Key, value: Value }, [
      { key: { uuid: "x" }, value: { url: "https://e/x" } },
    ]);
    expect(group).toEqual({
      namespace: "assets",
      store: "images",
      entries: [{ key: { uuid: "x" }, value: { url: "https://e/x" } }],
    });
  });
});

describe("defineSeed", () => {
  test("anchors and returns a seed set", () => {
    const set = defineSeed({
      name: "demo",
      order: 100,
      environments: ["dev", "staging"],
      d1: [d1SeedGroup("app", "widgets", Widget, [{ id: "a", active: false, createdAt: new Date(0) }])],
    });
    expect(set.name).toBe("demo");
    expect(set.environments).toEqual(["dev", "staging"]);
    expect(set.d1?.[0]?.table).toBe("widgets");
  });
});
