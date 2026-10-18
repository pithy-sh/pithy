// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { capabilityHealthSources, readCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { HealthSummaryKey } from "@pithy-sh/core/src/controlPlane/discovery/healthSummary";
import type { Context } from "hono";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { vector } from "../capability";
import { VectorConfig } from "../config/config";
import type { CorpusState } from "../data/corpusState";
import { VECTOR_INDEXES_READ_SCOPE } from "../http/scopes";
import { filterable } from "../index/filter";
import { VECTOR_PROVISIONED_VAR, type VectorProvisionRecord } from "../index/provisioned";
import {
  STALE_VECTOR_DOCUMENTS,
  staleDocuments,
  UNPROVISIONED_VECTOR_INDEXES,
  unprovisionedIndexes,
  vectorHealth,
} from "./health";

/**
 * The two keys vector contributes to its manifest entry, with every input injected. `defineCapabilityHealth`
 * parses the declaration and touches no binding, so what a client reads off the manifest about each key is
 * decidable here.
 */

const config = VectorConfig.parse({
  indexes: {
    docs: {
      model: "current",
      dimensions: 3,
      metadata: z.object({ ownerId: filterable(z.string().describe("Owner.")) }),
    },
    faqs: { model: "faq-model", dimensions: 3, binding: "FAQS" },
  },
});

const corpus = (counts: Record<string, { declaredModel: number; otherModel: number; unembedded: number }>) =>
  ({
    embedding: vi.fn(
      async (indexName: string) => counts[indexName] ?? { declaredModel: 0, otherModel: 0, unembedded: 0 },
    ),
    namespaces: vi.fn(async () => 0),
  }) satisfies CorpusState;

function keyed(name: string): HealthSummaryKey {
  const declared = vectorHealth(config).keys.find((key) => key.key === name);
  if (!declared) throw new Error(`the vector capability declares no health key ${name}`);
  return HealthSummaryKey.parse(declared);
}

describe("the health declaration (#730)", () => {
  test("declares exactly the two keys, both behind the index read's own scope", () => {
    const keys = vectorHealth(config).keys;
    expect(keys.map((key) => key.key)).toEqual([STALE_VECTOR_DOCUMENTS, UNPROVISIONED_VECTOR_INDEXES]);
    for (const key of keys) expect(key.scope).toBe(VECTOR_INDEXES_READ_SCOPE);
  });

  test("staleVectorDocuments is a count, zero is nominal, answered by the (indexName, model) index", () => {
    expect(keyed(STALE_VECTOR_DOCUMENTS)).toMatchObject({ kind: "count", nominal: { atMost: 0 }, cost: "indexed" });
  });

  test("unprovisionedVectorIndexes is a count, zero is nominal, read from a var already in hand", () => {
    expect(keyed(UNPROVISIONED_VECTOR_INDEXES)).toMatchObject({
      kind: "count",
      nominal: { atMost: 0 },
      cost: "memory",
    });
  });
});

describe("staleDocuments (#730)", () => {
  test("sums rows on another model and rows on none, across every declared index", async () => {
    const counts = corpus({
      docs: { declaredModel: 5, otherModel: 2, unembedded: 1 },
      faqs: { declaredModel: 1, otherModel: 4, unembedded: 0 },
    });
    expect(await staleDocuments(config, counts)).toBe(7);
    expect(counts.embedding).toHaveBeenCalledWith("docs", "current");
    expect(counts.embedding).toHaveBeenCalledWith("faqs", "faq-model");
  });

  test("a corpus wholly on its declared models is zero", async () => {
    expect(await staleDocuments(config, corpus({ docs: { declaredModel: 9, otherModel: 0, unembedded: 0 } }))).toBe(0);
  });
});

describe("unprovisionedIndexes (#730)", () => {
  const record: VectorProvisionRecord = {
    indexes: {
      docs: { indexName: "app-prod-docs", metadataIndexes: [{ propertyName: "ownerId", indexType: "string" }] },
    },
  };

  test("counts every declared index the record does not name", () => {
    expect(unprovisionedIndexes(config, record)).toBe(1);
  });

  test("no record is every declared index", () => {
    expect(unprovisionedIndexes(config, undefined)).toBe(2);
  });

  test("a drifted index is provisioned for this count — drift is the route's to name, not a second meaning here", () => {
    const drifted: VectorProvisionRecord = {
      indexes: {
        docs: { indexName: "app-prod-docs", metadataIndexes: [] },
        faqs: { indexName: "app-prod-faqs", metadataIndexes: [] },
      },
    };
    expect(unprovisionedIndexes(config, drifted)).toBe(0);
  });
});

describe("the health read (#730)", () => {
  const context = (env: Record<string, unknown>) => ({ env }) as unknown as Context<PithyHonoEnv>;

  test("produces both keys from the Worker's env and the corpus", async () => {
    const record: VectorProvisionRecord = { indexes: { docs: { indexName: "app-prod-docs", metadataIndexes: [] } } };
    const health = vectorHealth(config, () => corpus({ docs: { declaredModel: 0, otherModel: 3, unembedded: 0 } }));
    expect(await health.read(context({ [VECTOR_PROVISIONED_VAR]: JSON.stringify(record) }))).toEqual({
      [STALE_VECTOR_DOCUMENTS]: 3,
      [UNPROVISIONED_VECTOR_INDEXES]: 1,
    });
  });

  test("an unreadable record throws, so the seam reports the summary unavailable rather than a zero", async () => {
    const health = vectorHealth(config, () => corpus({}));
    await expect(health.read(context({ [VECTOR_PROVISIONED_VAR]: "{not json" }))).rejects.toThrow();
  });
});

describe("the health summary on the manifest (#730)", () => {
  // The real capability, through the seam's own assembly check and per-caller read.
  const source = capabilityHealthSources([vector({ indexes: { docs: { model: "m", dimensions: 3 } } })]).get("vector");

  test("passes the seam's assembly check: both keys sit behind a scope vector's own admin route requires", () => {
    expect(source?.keys.map((key) => key.key)).toEqual([STALE_VECTOR_DOCUMENTS, UNPROVISIONED_VECTOR_INDEXES]);
  });

  test("a caller without vector:indexes:read gets no value rather than a zero, and nothing is read", async () => {
    const produce = vi.fn(async () => ({ [STALE_VECTOR_DOCUMENTS]: 0, [UNPROVISIONED_VECTOR_INDEXES]: 0 }));
    expect(await readCapabilityHealth(source, ["manifest:read"], produce)).toEqual({ state: "withheld" });
    expect(produce).not.toHaveBeenCalled();
  });

  test("a caller with it gets both counts, zero included", async () => {
    const produce = async () => ({ [STALE_VECTOR_DOCUMENTS]: 0, [UNPROVISIONED_VECTOR_INDEXES]: 2 });
    expect(await readCapabilityHealth(source, [VECTOR_INDEXES_READ_SCOPE], produce)).toEqual({
      state: "reported",
      values: { [STALE_VECTOR_DOCUMENTS]: 0, [UNPROVISIONED_VECTOR_INDEXES]: 2 },
    });
  });
});
