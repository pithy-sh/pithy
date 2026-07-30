// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { extendMediaAsset, extensionColumns, sqliteColumnType } from "./extend";
import { MediaAsset } from "./mediaAsset";

describe("sqliteColumnType", () => {
  test("maps primitives to SQLite affinities", () => {
    expect(sqliteColumnType(z.string())).toEqual({ type: "text", notNull: true });
    expect(sqliteColumnType(z.number().int())).toEqual({ type: "integer", notNull: true });
    expect(sqliteColumnType(z.boolean())).toEqual({ type: "integer", notNull: true });
  });

  test("maps codecs by their output type (dates/booleans → integer, json → text)", () => {
    expect(sqliteColumnType(SQLiteDate)).toEqual({ type: "integer", notNull: true });
    expect(sqliteColumnType(SQLiteBoolean)).toEqual({ type: "integer", notNull: true });
    expect(sqliteColumnType(sqliteJson(z.array(z.string())))).toEqual({ type: "text", notNull: true });
  });

  test("optional / nullable / nullish fields are not-null false", () => {
    expect(sqliteColumnType(z.string().optional())).toEqual({ type: "text", notNull: false });
    expect(sqliteColumnType(z.string().nullable())).toEqual({ type: "text", notNull: false });
    expect(sqliteColumnType(z.string().nullish())).toEqual({ type: "text", notNull: false });
    expect(sqliteColumnType(SQLiteDate.nullish())).toEqual({ type: "integer", notNull: false });
  });

  test("a default keeps the inner type and is treated as not-null", () => {
    expect(sqliteColumnType(z.number().int().default(0))).toEqual({ type: "integer", notNull: true });
  });
});

describe("extendMediaAsset", () => {
  test("with no extension returns the base schema unchanged", () => {
    expect(extendMediaAsset()).toBe(MediaAsset);
  });

  test("widens an optional (undefined-only) extension field to accept null, for D1 read parity", () => {
    // A nullable D1 column returns SQLite NULL when omitted; a plain `.optional()` would throw on that
    // null. The effective schema must accept null so the D1 read round-trips (KV omits undefined and is
    // unaffected — this keeps the two stores in agreement).
    const effective = extendMediaAsset(z.object({ tag: z.string().optional().describe("A tag.") }).describe("ext"));
    expect(() => (effective.shape.tag as z.ZodType).parse(null)).not.toThrow();
    // A not-null field is left untouched (still rejects null).
    const required = extendMediaAsset(z.object({ userId: z.string().describe("owner") }).describe("ext"));
    expect(() => (required.shape.userId as z.ZodType).parse(null)).toThrow();
  });

  test("merges extension fields into the effective schema and round-trips them", () => {
    const extension = z
      .object({
        userId: z.string().describe("The owning user."),
        tenantId: z.string().nullish().describe("The owning tenant."),
      })
      .describe("Extra owner fields.");
    const effective = extendMediaAsset(extension);
    const row = {
      id: "m1",
      type: "image" as const,
      status: "stored" as const,
      name: "n",
      filename: "n.png",
      contentType: "image/png",
      storageBackend: "cf-images" as const,
      storageKey: "img1",
      hasTranscription: 0,
      hasExtractedText: 0,
      createdAt: 1000,
      updatedAt: 1000,
      userId: "u1",
    };
    const parsed = effective.parse(row);
    expect(parsed.userId).toBe("u1");
    expect(parsed.createdAt).toBeInstanceOf(Date);
  });
});

describe("extensionColumns", () => {
  test("with no extension yields no columns", () => {
    expect(extensionColumns()).toEqual([]);
  });

  test("derives a column spec per extension field, skipping base-field names", () => {
    const extension = z
      .object({
        userId: z.string().describe("The owning user."),
        rank: z.number().int().nullish().describe("A sort rank."),
        // A field colliding with a base column name is ignored (the base owns it).
        name: z.string().describe("Ignored — base already defines name."),
      })
      .describe("Extra fields.");
    expect(extensionColumns(extension)).toEqual([
      { name: "userId", type: "text", notNull: true },
      { name: "rank", type: "integer", notNull: false },
    ]);
  });
});
