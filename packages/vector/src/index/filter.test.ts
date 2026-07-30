// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertFilterSize, compileFilter, filterable, matchesCompiledFilter, vectorFilter } from "./filter";
import { MAX_FILTER_BYTES } from "./limits";
import type { MetadataIndexDescriptor } from "./metadata";

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("The tenant this document belongs to.")),
  words: filterable(z.number().describe("How many words the document has.")),
  published: filterable(z.boolean().describe("Whether the document is visible.")),
  title: z.string().describe("The document title — carried for hydration, never filtered on."),
});

const descriptors: MetadataIndexDescriptor[] = [
  { propertyName: "tenantId", indexType: "string" },
  { propertyName: "words", indexType: "number" },
  { propertyName: "published", indexType: "boolean" },
];

/** The code a thrown PithyError carries — the assertion every error test makes. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a PithyError");
}

describe("vectorFilter", () => {
  it("expands a bare value to $eq — Vectorize's own shorthand, normalized before the wire", () => {
    expect(vectorFilter(DocMeta, { tenantId: "acme" })).toEqual({ tenantId: { $eq: "acme" } });
  });

  it("passes every operator through", () => {
    expect(
      vectorFilter(DocMeta, {
        tenantId: { $in: ["acme", "globex"], $ne: "initech" },
        words: { $gte: 10, $lt: 100 },
        published: { $eq: true },
      }),
    ).toEqual({
      tenantId: { $in: ["acme", "globex"], $ne: "initech" },
      words: { $gte: 10, $lt: 100 },
      published: { $eq: true },
    });
  });

  it("rejects an unmarked field at compile time, and again at runtime for untyped callers", () => {
    expect(
      codeOf(() =>
        // @ts-expect-error `title` is not marked filterable, so it is not a key of the filter type.
        vectorFilter(DocMeta, { title: "anything" }),
      ),
    ).toBe("vector/unfilterable_field");
  });

  it("skips an undefined condition rather than compiling an empty comparison", () => {
    expect(vectorFilter(DocMeta, { tenantId: undefined })).toEqual({});
  });
});

describe("compileFilter — the untyped runtime guard", () => {
  it("rejects a field with no metadata index", () => {
    expect(codeOf(() => compileFilter(descriptors, { author: "ada" }))).toBe("vector/unfilterable_field");
  });

  it("rejects a key Vectorize reserves: a leading $, a dot, or an empty name", () => {
    for (const key of ["$or", "user.id", ""]) {
      expect(codeOf(() => compileFilter(descriptors, { [key]: "x" }))).toBe("validation/invalid_input");
    }
  });

  it("rejects a key over 512 characters", () => {
    expect(codeOf(() => compileFilter(descriptors, { ["a".repeat(513)]: "x" }))).toBe("validation/invalid_input");
  });

  it("rejects an operator Vectorize does not have", () => {
    expect(codeOf(() => compileFilter(descriptors, { tenantId: { $regex: "acme" } }))).toBe("validation/invalid_input");
  });

  it("rejects a value whose type is not the type the property was indexed as", () => {
    expect(codeOf(() => compileFilter(descriptors, { words: "ten" }))).toBe("validation/invalid_input");
    expect(codeOf(() => compileFilter(descriptors, { tenantId: { $in: ["acme", 7] } }))).toBe(
      "validation/invalid_input",
    );
  });

  it("rejects an empty $in — a set filter with no members matches nothing and means nothing", () => {
    expect(codeOf(() => compileFilter(descriptors, { tenantId: { $in: [] } }))).toBe("validation/invalid_input");
  });

  it("rejects a comparison object with no operators left after undefined is dropped", () => {
    expect(codeOf(() => compileFilter(descriptors, { tenantId: { $eq: undefined } }))).toBe("validation/invalid_input");
  });

  it("accepts null, which Vectorize compares as a value", () => {
    expect(compileFilter(descriptors, { tenantId: null })).toEqual({ tenantId: { $eq: null } });
  });
});

describe("filter size — the 2,048-byte ceiling is exclusive", () => {
  /** A filter whose compact JSON is exactly `size` bytes. The envelope `{"tenantId":{"$eq":""}}` is 23 bytes. */
  const filterOfSize = (size: number) => ({ tenantId: { $eq: "x".repeat(size - 23) } });

  it("the envelope arithmetic is right", () => {
    expect(JSON.stringify(filterOfSize(2047)).length).toBe(2047);
  });

  it("accepts 2,047 bytes", () => {
    expect(() => assertFilterSize(filterOfSize(MAX_FILTER_BYTES - 1))).not.toThrow();
  });

  it("rejects 2,048 bytes — the limit is 'less than 2048', not 'at most'", () => {
    expect(codeOf(() => assertFilterSize(filterOfSize(MAX_FILTER_BYTES)))).toBe("vector/filter_too_large");
  });

  it("is enforced by compileFilter, so no oversized filter reaches Vectorize", () => {
    expect(codeOf(() => compileFilter(descriptors, filterOfSize(MAX_FILTER_BYTES)))).toBe("vector/filter_too_large");
  });
});

describe("matchesCompiledFilter", () => {
  const metadata = { ownerId: "ada", rank: 3, live: true };

  it("matches every operator the compiler emits", () => {
    expect(matchesCompiledFilter(metadata, { ownerId: { $eq: "ada" } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { ownerId: { $ne: "ada" } })).toBe(false);
    expect(matchesCompiledFilter(metadata, { ownerId: { $in: ["ada", "grace"] } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { ownerId: { $nin: ["ada"] } })).toBe(false);
    expect(matchesCompiledFilter(metadata, { rank: { $lt: 4 } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { rank: { $lte: 3 } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { rank: { $gt: 3 } })).toBe(false);
    expect(matchesCompiledFilter(metadata, { rank: { $gte: 3 } })).toBe(true);
  });

  it("ANDs every named property, as Vectorize does", () => {
    expect(matchesCompiledFilter(metadata, { ownerId: { $eq: "ada" }, rank: { $gte: 3 } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { ownerId: { $eq: "ada" }, rank: { $gt: 3 } })).toBe(false);
  });

  it("treats an absent property the way Vectorize does — only the negative operators match", () => {
    expect(matchesCompiledFilter(metadata, { missing: { $eq: "x" } })).toBe(false);
    expect(matchesCompiledFilter(metadata, { missing: { $ne: "x" } })).toBe(true);
    expect(matchesCompiledFilter(metadata, { missing: { $gt: 1 } })).toBe(false);
  });

  it("matches nothing on an ordered comparison between different types", () => {
    expect(matchesCompiledFilter(metadata, { ownerId: { $gt: 1 } })).toBe(false);
  });

  it("matches everything when the filter is empty", () => {
    expect(matchesCompiledFilter(metadata, {})).toBe(true);
  });

  it("agrees with the compiler's shorthand expansion — a bare value is $eq", () => {
    const compiled = compileFilter([{ propertyName: "ownerId", indexType: "string" }], { ownerId: "ada" });
    expect(matchesCompiledFilter(metadata, compiled)).toBe(true);
  });
});
