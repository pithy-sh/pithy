import { describe, expect, it } from "vitest";
import { z } from "zod";
import { filterable } from "../index/filter";
import { VectorConfig } from "./config";
import { toWorkerConfig, VectorWorkerConfig } from "./workerConfig";

/**
 * The projection exists because an index's `metadata` is a live Zod schema and a wrangler var is a string.
 * The test that earns its keep is the round trip through JSON: whatever the worker parses back must be
 * everything it needs, which is exactly what a naive `JSON.stringify(config)` would fail to be.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  rank: filterable(z.number().describe("Rank.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: {
    docs: { model: "current-model", dimensions: 768, metadata, namespace: "tenant-1" },
    notes: { model: "other-model", dimensions: 384, metric: "euclidean", binding: "VECTORIZE_NOTES" },
  },
});

const indexNames: Record<string, string> = { docs: "pithy-vector-docs-staging", notes: "pithy-vector-notes-staging" };

describe("toWorkerConfig", () => {
  it("carries the provisioned index name, the binding, the model, the shape, and the namespace", () => {
    const projected = toWorkerConfig(config, (name) => indexNames[name] ?? "");
    expect(projected.indexes.docs).toEqual({
      indexName: "pithy-vector-docs-staging",
      binding: "VECTORIZE",
      model: "current-model",
      dimensions: 768,
      metric: "cosine",
      namespace: "tenant-1",
      filterable: [
        { propertyName: "ownerId", indexType: "string" },
        { propertyName: "rank", indexType: "number" },
      ],
    });
  });

  it("survives the trip through a wrangler var, which the config itself would not", () => {
    const projected = toWorkerConfig(config, (name) => indexNames[name] ?? "");
    const parsed = VectorWorkerConfig.parse(JSON.parse(JSON.stringify(projected)));
    expect(parsed.indexes.notes?.metric).toBe("euclidean");
    expect(parsed.indexes.docs?.filterable).toHaveLength(2);
  });

  it("projects an index with no metadata schema as filterable-empty, not absent", () => {
    expect(toWorkerConfig(config, (name) => indexNames[name] ?? "").indexes.notes?.filterable).toEqual([]);
  });

  it("throws for a metadata schema that cannot be provisioned, before a worker is deployed against it", () => {
    const broken = VectorConfig.parse({ indexes: { docs: { model: "m", dimensions: 8 } } });
    // Swap in an unindexable filterable field after the parse, so the failure is the projection's, not the
    // config's — the projection is the last gate before a deploy.
    const index = broken.indexes.docs;
    if (!index) throw new Error("test config lost its index");
    index.metadata = z.object({ tags: filterable(z.array(z.string()).describe("Tags.")) });
    expect(() => toWorkerConfig(broken, () => "x")).toThrow(/cannot be provisioned/);
  });
});
