// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { argumentClass, jsonType, MAX_CLASSED_KEYS, MAX_RECORDED_TEXT, pathParamNames } from "./argumentClass";

const MARK = "MARKED-VALUE-7f3a";

describe("jsonType", () => {
  test("names each JSON type, and an array apart from an object", () => {
    expect(["s", 1, true, null, [], {}].map(jsonType)).toEqual([
      "string",
      "number",
      "boolean",
      "null",
      "array",
      "object",
    ]);
  });
});

describe("pathParamNames", () => {
  test("reads Hono's named parameters, patterned and optional ones included, and a trailing wildcard as path", () => {
    expect(pathParamNames("/notes/:id/tags/:tag{[a-z]+}/:rest?")).toEqual(["id", "tag", "rest"]);
    expect(pathParamNames("/files/*")).toEqual(["path"]);
    expect(pathParamNames("/notes")).toEqual([]);
  });
});

describe("argumentClass", () => {
  test("keeps the route's path parameters verbatim, and only the ones it declares", () => {
    expect(argumentClass("/threads/:threadId", { path: { threadId: "t-1", smuggled: MARK } })).toEqual({
      path: { threadId: "t-1" },
    });
  });

  test("a query and a body leave their top-level key names, sorted, with each value's JSON type", () => {
    expect(
      argumentClass("/notes", {
        query: { limit: 10, cursor: "abc" },
        body: { text: "hi", tags: ["a"], meta: { deep: 1 }, archived: false, owner: null },
      }),
    ).toEqual({
      query: {
        type: "object",
        keys: [
          { key: "cursor", type: "string" },
          { key: "limit", type: "number" },
        ],
      },
      body: {
        type: "object",
        keys: [
          { key: "archived", type: "boolean" },
          { key: "meta", type: "object" },
          { key: "owner", type: "null" },
          { key: "tags", type: "array" },
          { key: "text", type: "string" },
        ],
      },
    });
  });

  test("no value, no length and no nested key of a marked query or body reaches the class", () => {
    const classed = argumentClass("/notes/:id", {
      path: { id: "n1" },
      query: { q: MARK, list: [MARK, MARK] },
      body: { secret: MARK, nested: { [`${MARK}-key`]: MARK, inner: MARK }, items: [{ v: MARK }] },
    });
    const written = JSON.stringify(classed);
    expect(written).not.toContain(MARK);
    expect(written).not.toContain("inner");
    expect(written).not.toContain(String(MARK.length));
  });

  test("a body that is not an object leaves only its type", () => {
    expect(argumentClass("/notes", { body: [1, 2] })).toEqual({ body: { type: "array" } });
    expect(argumentClass("/notes", { body: MARK })).toEqual({ body: { type: "string" } });
  });

  test("past the cap, the keys are counted rather than named", () => {
    const body = Object.fromEntries(Array.from({ length: MAX_CLASSED_KEYS + 3 }, (_, i) => [`k${i}`, i]));
    const classed = argumentClass("/notes", { body });
    expect(classed.body?.keys).toHaveLength(MAX_CLASSED_KEYS);
    expect(classed.body?.omitted).toBe(3);
  });

  test("a key name past the bound is cut to it and marked, so a row stays bounded however long the keys", () => {
    const long = (i: number) => `${String(i).padStart(2, "0")}${"k".repeat(40_000)}`;
    const body = Object.fromEntries(Array.from({ length: MAX_CLASSED_KEYS }, (_, i) => [long(i), i]));
    const classed = argumentClass("/notes", { query: { [long(0)]: 1, short: 2 }, body });
    expect(classed.query?.keys).toEqual([
      { key: long(0).slice(0, MAX_RECORDED_TEXT), type: "number", truncated: true },
      { key: "short", type: "number" },
    ]);
    expect(classed.body?.keys).toHaveLength(MAX_CLASSED_KEYS);
    for (const key of classed.body?.keys ?? []) expect(key.key).toHaveLength(MAX_RECORDED_TEXT);
    expect(JSON.stringify(classed).length).toBeLessThan(2 * MAX_CLASSED_KEYS * (MAX_RECORDED_TEXT + 64));
  });

  test("a path value past the bound is cut to it, and the parameter is named as cut", () => {
    const long = "p".repeat(40_000);
    expect(argumentClass("/notes/:id/tags/:tag", { path: { id: long, tag: "t" } })).toEqual({
      path: { id: long.slice(0, MAX_RECORDED_TEXT), tag: "t" },
      truncatedPath: ["id"],
    });
    const wildcard = argumentClass("/files/*", { path: { path: `a/${long}` } });
    expect(wildcard.path?.path).toHaveLength(MAX_RECORDED_TEXT);
    expect(wildcard.truncatedPath).toEqual(["path"]);
  });

  test("no arguments leave nothing", () => {
    expect(argumentClass("/notes", {})).toEqual({});
  });
});
