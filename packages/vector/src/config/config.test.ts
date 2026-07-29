import { describe, expect, it } from "vitest";
import { z } from "zod";
import { filterable } from "../index/filter";
import { MAX_DIMENSIONS, MAX_METADATA_INDEXES } from "../index/limits";
import { resolveIndex, VectorConfig } from "./config";

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("Tenant.")),
  title: z.string().describe("Title."),
});

const docs = { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metadata: DocMeta };

/** The messages of a failed parse, joined — enough to assert which rule fired. */
function problems(input: unknown): string {
  const result = VectorConfig.safeParse(input);
  expect(result.success).toBe(false);
  return result.error?.issues.map((issue) => issue.message).join(" | ") ?? "";
}

describe("VectorConfig", () => {
  it("defaults the metric to cosine and topK to ten", () => {
    const config = VectorConfig.parse({ indexes: { docs } });
    expect(config.indexes.docs?.metric).toBe("cosine");
    expect(config.defaultTopK).toBe(10);
  });

  it("accepts no indexes — inert, but loadable, which is what `pithy add vector` needs", () => {
    // `pithy add` can seed only scalar config options, so the pithy.config.ts it writes carries no
    // `indexes` block. Rejecting that would make the generated file throw on load.
    expect(VectorConfig.safeParse({ indexes: {} }).success).toBe(true);
    expect(VectorConfig.parse({}).indexes).toEqual({});
  });

  it("rejects dimensions above Vectorize's ceiling, where the fix is an edit rather than a migration", () => {
    expect(problems({ indexes: { docs: { ...docs, dimensions: MAX_DIMENSIONS + 1 } } })).not.toBe("");
  });

  it("rejects an index name Vectorize could not carry", () => {
    expect(problems({ indexes: { ["a".repeat(65)]: docs } })).toContain("64 bytes");
  });

  it("rejects an index name that is not a usable resource name or path segment", () => {
    expect(problems({ indexes: { "Docs Index": docs } })).toContain("lowercase");
  });

  it("rejects a namespace over 64 bytes", () => {
    expect(problems({ indexes: { docs: { ...docs, namespace: "n".repeat(65) } } })).toContain("64 bytes");
  });

  it("rejects a metadata that is a value rather than a schema", () => {
    expect(problems({ indexes: { docs: { ...docs, metadata: { tenantId: "acme" } } } })).toContain("Zod object");
  });

  it("rejects an eleventh filterable field at parse time — before provisioning half-configures the index", () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < MAX_METADATA_INDEXES + 1; i += 1) {
      shape[`f${i}`] = filterable(z.string().describe(`Field ${i}.`));
    }
    expect(problems({ indexes: { docs: { ...docs, metadata: z.object(shape) } } })).toContain("11 fields");
  });

  it("accepts exactly ten", () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < MAX_METADATA_INDEXES; i += 1) {
      shape[`f${i}`] = filterable(z.string().describe(`Field ${i}.`));
    }
    expect(VectorConfig.safeParse({ indexes: { docs: { ...docs, metadata: z.object(shape) } } }).success).toBe(true);
  });

  it("rejects a filterable field whose type Vectorize cannot index", () => {
    const metadata = z.object({ tags: filterable(z.array(z.string()).describe("Tags.")) });
    expect(problems({ indexes: { docs: { ...docs, metadata } } })).toContain("Only strings, numbers, and booleans");
  });
});

describe("resolveIndex", () => {
  it("finds a configured index", () => {
    const config = VectorConfig.parse({ indexes: { docs } });
    expect(resolveIndex(config, "docs")?.model).toBe("@cf/baai/bge-base-en-v1.5");
  });

  it("returns undefined for an index nobody configured — a 404, not a crash", () => {
    const config = VectorConfig.parse({ indexes: { docs } });
    expect(resolveIndex(config, "nope")).toBeUndefined();
  });
});
