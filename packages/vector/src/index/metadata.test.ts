import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { filterable } from "./filter";
import { MAX_METADATA_INDEXES } from "./limits";
import { introspectMetadata, isFilterable, metadataIndexes } from "./metadata";

/** A metadata schema with `count` filterable string fields, named f0…fN. */
function schemaWithFilterableFields(count: number): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < count; i += 1) {
    shape[`f${i}`] = filterable(z.string().describe(`Filterable field ${i}.`));
  }
  return z.object(shape);
}

describe("isFilterable", () => {
  it("reads the marker set by .meta({ filterable: true }), in either order with .describe()", () => {
    expect(isFilterable(z.string().meta({ filterable: true }).describe("d"))).toBe(true);
    expect(isFilterable(z.string().describe("d").meta({ filterable: true }))).toBe(true);
  });

  it("reads it through a wrapper — the wrapper is a different schema and carries no metadata of its own", () => {
    expect(isFilterable(filterable(z.string().describe("d")).optional())).toBe(true);
    expect(isFilterable(filterable(z.number().describe("d")).nullable())).toBe(true);
  });

  it("is false for an unmarked field", () => {
    expect(isFilterable(z.string().describe("d"))).toBe(false);
  });
});

describe("introspectMetadata", () => {
  it("derives one descriptor per marked field, in declaration order, and skips the rest", () => {
    const schema = z.object({
      tenantId: filterable(z.string().describe("Tenant.")),
      title: z.string().describe("Title — not filterable."),
      words: filterable(z.number().describe("Word count.")),
      published: filterable(z.boolean().describe("Visible.")),
    });
    expect(introspectMetadata(schema)).toEqual({
      indexes: [
        { propertyName: "tenantId", indexType: "string" },
        { propertyName: "words", indexType: "number" },
        { propertyName: "published", indexType: "boolean" },
      ],
      problems: [],
    });
  });

  it("indexes an enum and a literal as the primitive they constrain", () => {
    const schema = z.object({
      status: filterable(z.enum(["draft", "live"]).describe("Status.")),
      version: filterable(z.literal(2).describe("Schema version.")),
    });
    expect(introspectMetadata(schema).indexes).toEqual([
      { propertyName: "status", indexType: "string" },
      { propertyName: "version", indexType: "number" },
    ]);
  });

  it("sees through .optional(), .nullable(), and .default()", () => {
    const schema = z.object({
      a: filterable(z.string().describe("a")).optional(),
      b: filterable(z.number().describe("b")).nullable(),
      c: filterable(z.boolean().describe("c")).default(false),
    });
    expect(introspectMetadata(schema).indexes).toEqual([
      { propertyName: "a", indexType: "string" },
      { propertyName: "b", indexType: "number" },
      { propertyName: "c", indexType: "boolean" },
    ]);
  });

  it("reports a marked field Vectorize cannot index, rather than silently dropping it", () => {
    const schema = z.object({ tags: filterable(z.array(z.string()).describe("Tags.")) });
    const { indexes, problems } = introspectMetadata(schema);
    expect(indexes).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("tags");
  });

  it("reports a marked field whose name Vectorize reserves", () => {
    const schema = z.object({ "user.id": filterable(z.string().describe("Nested-looking key.")) });
    expect(introspectMetadata(schema).problems[0]).toContain("dot");
  });

  it("collects every problem in one pass, so a config parse reports them together", () => {
    const schema = z.object({
      tags: filterable(z.array(z.string()).describe("Tags.")),
      "a.b": filterable(z.string().describe("Nested-looking key.")),
    });
    expect(introspectMetadata(schema).problems).toHaveLength(2);
  });
});

describe("the ten-metadata-index ceiling", () => {
  it("accepts exactly ten filterable fields", () => {
    const { indexes, problems } = introspectMetadata(schemaWithFilterableFields(MAX_METADATA_INDEXES));
    expect(indexes).toHaveLength(10);
    expect(problems).toEqual([]);
  });

  it("fails at eleven — at assembly, not when Vectorize rejects the eleventh mid-provision", () => {
    const { problems } = introspectMetadata(schemaWithFilterableFields(MAX_METADATA_INDEXES + 1));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("11 fields are marked filterable");
  });
});

describe("metadataIndexes", () => {
  it("returns the descriptors when the schema is clean", () => {
    expect(metadataIndexes(schemaWithFilterableFields(2))).toEqual([
      { propertyName: "f0", indexType: "string" },
      { propertyName: "f1", indexType: "string" },
    ]);
  });

  it("throws a typed error rather than returning a half-usable answer", () => {
    try {
      metadataIndexes(schemaWithFilterableFields(MAX_METADATA_INDEXES + 1));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("validation/invalid_input");
    }
  });
});
