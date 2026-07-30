// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { assertMetadataIndexes, compareMetadataIndexes, type MetadataIndexSource } from "./drift";
import type { MetadataIndexDescriptor } from "./metadata";

const declared: MetadataIndexDescriptor[] = [
  { propertyName: "tenantId", indexType: "string" },
  { propertyName: "published", indexType: "boolean" },
];

const source = (live: { propertyName: string; indexType: string }[]): MetadataIndexSource => ({
  listMetadataIndexes: async () => live,
});

describe("compareMetadataIndexes", () => {
  it("finds nothing wrong when live matches declared", () => {
    expect(compareMetadataIndexes(declared, declared)).toEqual({ missing: [], mismatched: [], extra: [] });
  });

  it("reports a declared index that does not exist", () => {
    const report = compareMetadataIndexes(declared, [{ propertyName: "tenantId", indexType: "string" }]);
    expect(report.missing).toEqual([{ propertyName: "published", indexType: "boolean" }]);
  });

  it("reports an index created with a different type — comparisons against the wrong type never match", () => {
    const report = compareMetadataIndexes(declared, [
      { propertyName: "tenantId", indexType: "number" },
      { propertyName: "published", indexType: "boolean" },
    ]);
    expect(report.mismatched).toEqual([{ propertyName: "tenantId", declared: "string", live: "number" }]);
  });

  it("reports an undeclared live index without treating it as an error — it still spends a slot", () => {
    const report = compareMetadataIndexes(declared, [...declared, { propertyName: "legacy", indexType: "string" }]);
    expect(report.extra).toEqual([{ propertyName: "legacy", indexType: "string" }]);
    expect(report.missing).toEqual([]);
  });
});

describe("assertMetadataIndexes", () => {
  it("returns the report when every declared index is live", async () => {
    const report = await assertMetadataIndexes(source(declared), "docs", declared);
    expect(report.missing).toEqual([]);
  });

  it("refuses to continue when a declared index is missing — silently partial search is the alternative", async () => {
    try {
      await assertMetadataIndexes(source([]), "docs", declared);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.code).toBe("vector/metadata_index_drift");
      expect(payload.status).toBe(500);
      // The field and the fix both have to be in the error, or the reader is left guessing.
      expect(payload.detail).toContain("tenantId");
      expect(payload.action).toContain("pithy vector provision");
      expect(payload.message).toContain("docs");
    }
  });

  it("refuses to continue on a type mismatch too", async () => {
    const live = [
      { propertyName: "tenantId", indexType: "string" },
      { propertyName: "published", indexType: "string" },
    ];
    await expect(assertMetadataIndexes(source(live), "docs", declared)).rejects.toThrow(PithyError);
  });

  it("does not fail on an undeclared live index", async () => {
    const live = [...declared, { propertyName: "legacy", indexType: "string" }];
    await expect(assertMetadataIndexes(source(live), "docs", declared)).resolves.toMatchObject({
      extra: [{ propertyName: "legacy", indexType: "string" }],
    });
  });
});
