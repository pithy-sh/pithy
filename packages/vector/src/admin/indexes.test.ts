// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { VectorConfig, type VectorIndexConfig } from "../config/config";
import type { CorpusState } from "../data/corpusState";
import { VectorIndexesResponse } from "../http/responses";
import { filterable } from "../index/filter";
import type { VectorStore } from "../index/index";
import { readProvisionRecord, VECTOR_PROVISIONED_VAR, type VectorProvisionRecord } from "../index/provisioned";
import { type IndexReadDeps, provisionState, readIndexes } from "./indexes";

/**
 * The index read, with every input injected: config, the provision record, a store per binding, and the corpus.
 * Nothing here touches D1 or Vectorize — `corpusState.workers.test.ts` and `index.test.ts` prove those halves.
 */

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  rank: filterable(z.number().describe("Rank.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: {
    docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metadata },
    faqs: { model: "@cf/baai/bge-small-en-v1.5", dimensions: 384, metric: "dot-product", binding: "FAQS" },
  },
});

const docsIndex = config.indexes.docs as VectorIndexConfig;

/** The record a clean provision of `docs` leaves. `faqs` declares nothing filterable. */
const agreeing: VectorProvisionRecord = {
  indexes: {
    docs: {
      indexName: "app-prod-docs",
      metadataIndexes: [
        { propertyName: "ownerId", indexType: "string" },
        { propertyName: "rank", indexType: "number" },
      ],
    },
    faqs: { indexName: "app-prod-faqs", metadataIndexes: [] },
  },
};

function store(dimensions: number, vectorCount = 10): VectorStore {
  return {
    upsert: async () => ({ mutationId: "m" }),
    query: async () => ({ count: 0, matches: [] }),
    describe: async () => ({
      vectorCount,
      dimensions,
      processedUpToDatetime: "2026-10-18T11:00:00.000Z",
      processedUpToMutation: "mutation-7",
    }),
  };
}

const corpus: CorpusState = {
  embedding: vi.fn(async (indexName: string) =>
    indexName === "docs"
      ? { declaredModel: 7, otherModel: 2, unembedded: 1 }
      : { declaredModel: 0, otherModel: 0, unembedded: 0 },
  ),
  namespaces: vi.fn(async (indexName: string) => (indexName === "docs" ? 3 : 0)),
  hasStale: vi.fn(async (indexName: string) => indexName === "docs"),
};

function deps(overrides: Partial<IndexReadDeps> = {}): IndexReadDeps {
  const bindings: Record<string, VectorStore> = { VECTORIZE: store(768), FAQS: store(384, 0) };
  return {
    config,
    record: agreeing,
    environment: "prod",
    store: (index) => bindings[index.binding],
    corpus,
    ...overrides,
  };
}

describe("readIndexes (#730)", () => {
  test("reports every declared index, in config order, in the declared response shape", async () => {
    const report = await readIndexes(deps());
    expect(VectorIndexesResponse.parse(report)).toEqual(report);
    expect(report.environment).toBe("prod");
    expect(report.indexes.map((index) => index.name)).toEqual(["docs", "faqs"]);
  });

  test("states what config declares beside what Vectorize returns", async () => {
    const [docs, faqs] = (await readIndexes(deps())).indexes;
    expect(docs?.declared).toEqual({ model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metric: "cosine" });
    expect(docs?.vectorize).toEqual({
      state: "read",
      vectorCount: 10,
      dimensions: 768,
      processedUpToDatetime: "2026-10-18T11:00:00.000Z",
      processedUpToMutation: "mutation-7",
      dimensionMismatch: null,
    });
    expect(faqs?.declared).toEqual({ model: "@cf/baai/bge-small-en-v1.5", dimensions: 384, metric: "dot-product" });
    expect(faqs?.vectorize).toMatchObject({ state: "read", vectorCount: 0 });
  });

  test("names a dimension mismatch, with the reset as a person's decision and never a fix to run", async () => {
    const bindings: Record<string, VectorStore> = { VECTORIZE: store(384), FAQS: store(384) };
    const [docs] = (await readIndexes(deps({ store: (index) => bindings[index.binding] }))).indexes;
    expect(docs?.vectorize.state).toBe("read");
    const mismatch = docs?.vectorize.state === "read" ? docs.vectorize.dimensionMismatch : null;
    expect(mismatch).toMatchObject({ declared: 768, actual: 384 });
    expect(mismatch?.message).toContain("pithy vector reset");
    expect(mismatch?.message).toContain("person's decision");
  });

  test("an index whose describe fails is unreadable, never zero vectors, and the rest still answer", async () => {
    const broken: VectorStore = {
      ...store(768),
      describe: async () => {
        throw new Error("boom");
      },
    };
    const report = await readIndexes(deps({ store: (index) => (index.binding === "VECTORIZE" ? broken : store(384)) }));
    expect(report.indexes[0]?.vectorize).toEqual({ state: "unreadable", reason: "failed" });
    expect(report.indexes[1]?.vectorize.state).toBe("read");
  });

  test("an index with no binding on the Worker is unreadable as unbound", async () => {
    const [docs] = (await readIndexes(deps({ store: () => undefined }))).indexes;
    expect(docs?.vectorize).toEqual({ state: "unreadable", reason: "unbound" });
  });

  test("reports the model breakdown against each index's own declared model", async () => {
    const [docs, faqs] = (await readIndexes(deps())).indexes;
    expect(docs?.documents).toEqual({ declaredModel: 7, otherModel: 2, unembedded: 1 });
    expect(faqs?.documents).toEqual({ declaredModel: 0, otherModel: 0, unembedded: 0 });
    expect(corpus.embedding).toHaveBeenCalledWith("docs", "@cf/baai/bge-base-en-v1.5");
    expect(corpus.embedding).toHaveBeenCalledWith("faqs", "@cf/baai/bge-small-en-v1.5");
  });

  test("reports how many namespaces, as a number, and carries no namespace name anywhere", async () => {
    const report = await readIndexes(deps());
    expect(report.indexes[0]?.namespaces).toBe(3);
    // The fake corpus knows no names to leak, so the shape is what is asserted: a count is the whole field.
    expect(typeof report.indexes[0]?.namespaces).toBe("number");
  });

  test("an environment the Worker was never told is null, and the remedies name the flag instead", async () => {
    const report = await readIndexes(deps({ environment: undefined, record: undefined }));
    expect(report.environment).toBeNull();
    const provision = report.indexes[0]?.provision;
    expect(provision?.state).toBe("unprovisioned");
    expect(provision?.state === "unprovisioned" ? provision.message : "").toContain("--env");
  });
});

describe("provisionState (#730)", () => {
  test("an index named after an Object.prototype key is unprovisioned when the parsed record does not name it", () => {
    const parsed = readProvisionRecord({ [VECTOR_PROVISIONED_VAR]: '{"indexes":{}}' });
    const state = provisionState("constructor", docsIndex, parsed, "staging");
    expect(state.state).toBe("unprovisioned");
  });

  test("an index absent from the record is unprovisioned, never omitted", () => {
    const state = provisionState("docs", docsIndex, { indexes: {} }, "staging");
    expect(state.state).toBe("unprovisioned");
    expect(state.state === "unprovisioned" ? state.message : "").toContain("pithy vector provision");
  });

  test("no record at all is every index unprovisioned, filterable or not", () => {
    expect(provisionState("docs", docsIndex, undefined, "staging").state).toBe("unprovisioned");
    expect(provisionState("faqs", config.indexes.faqs as VectorIndexConfig, undefined, "staging").state).toBe(
      "unprovisioned",
    );
  });

  test("a record matching the declared filterable set is provisioned", () => {
    expect(provisionState("docs", docsIndex, agreeing, "prod")).toEqual({ state: "provisioned" });
  });

  test("a field marked filterable that provision never saw is drifted, distinctly from unprovisioned", () => {
    const record: VectorProvisionRecord = {
      indexes: {
        docs: { indexName: "app-prod-docs", metadataIndexes: [{ propertyName: "ownerId", indexType: "string" }] },
      },
    };
    const state = provisionState("docs", docsIndex, record, "staging");
    expect(state.state).toBe("drifted");
    if (state.state !== "drifted") return;
    expect(state.missing).toEqual([{ propertyName: "rank", indexType: "number" }]);
    expect(state.mismatched).toEqual([]);
    expect(state.message).toContain("pithy vector provision");
  });

  test("a field indexed as another type is drifted, and names the reset as a person's decision", () => {
    const record: VectorProvisionRecord = {
      indexes: {
        docs: {
          indexName: "app-prod-docs",
          metadataIndexes: [
            { propertyName: "ownerId", indexType: "string" },
            { propertyName: "rank", indexType: "string" },
          ],
        },
      },
    };
    const state = provisionState("docs", docsIndex, record, "prod");
    expect(state.state).toBe("drifted");
    if (state.state !== "drifted") return;
    expect(state.missing).toEqual([]);
    expect(state.mismatched).toEqual([{ propertyName: "rank", declared: "number", indexed: "string" }]);
    expect(state.message).toContain("pithy vector reset");
    expect(state.message).toContain("person's decision");
  });

  test("a live metadata index config does not declare is not drift — it may belong to another consumer", () => {
    const record: VectorProvisionRecord = {
      indexes: {
        docs: {
          indexName: "app-prod-docs",
          metadataIndexes: [
            ...(agreeing.indexes.docs?.metadataIndexes ?? []),
            { propertyName: "legacy", indexType: "string" },
          ],
        },
      },
    };
    expect(provisionState("docs", docsIndex, record, "prod")).toEqual({ state: "provisioned" });
  });
});
