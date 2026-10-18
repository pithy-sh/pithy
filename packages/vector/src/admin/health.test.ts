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
  corpusEmbedding,
  UNPROVISIONED_VECTOR_INDEXES,
  unprovisionedIndexes,
  VECTOR_CORPUS_EMBEDDING,
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

/** A corpus where the named indexes hold a row off their declared model. The counts must never be read. */
const corpus = (staleIndexes: readonly string[]) =>
  ({
    embedding: vi.fn(async () => {
      throw new Error("the manifest must not count the corpus: a count reads every row an index holds");
    }),
    namespaces: vi.fn(async () => {
      throw new Error("the manifest must not count namespaces");
    }),
    hasStale: vi.fn(async (indexName: string) => staleIndexes.includes(indexName)),
  }) satisfies CorpusState;

function keyed(name: string): HealthSummaryKey {
  const declared = vectorHealth(config).keys.find((key) => key.key === name);
  if (!declared) throw new Error(`the vector capability declares no health key ${name}`);
  return HealthSummaryKey.parse(declared);
}

describe("the health declaration (#730)", () => {
  test("declares exactly the two keys, both behind the index read's own scope", () => {
    const keys = vectorHealth(config).keys;
    expect(keys.map((key) => key.key)).toEqual([VECTOR_CORPUS_EMBEDDING, UNPROVISIONED_VECTOR_INDEXES]);
    for (const key of keys) expect(key.scope).toBe(VECTOR_INDEXES_READ_SCOPE);
  });

  test("vectorCorpusEmbedding is a state, current is nominal, answered by bounded seeks on the (indexName, model) index", () => {
    // A state and not a count: `indexed` means the rows read are bounded by a declaration, and a count of
    // stale rows reads every row an index holds. The count is the index read's to report.
    expect(keyed(VECTOR_CORPUS_EMBEDDING)).toMatchObject({
      kind: "state",
      states: ["current", "stale"],
      nominal: ["current"],
      cost: "indexed",
    });
  });

  test("unprovisionedVectorIndexes is a count, zero is nominal, read from a var already in hand", () => {
    expect(keyed(UNPROVISIONED_VECTOR_INDEXES)).toMatchObject({
      kind: "count",
      nominal: { atMost: 0 },
      cost: "memory",
    });
  });
});

describe("corpusEmbedding (#730)", () => {
  test("is stale when any declared index holds a row off its declared model, probing each against its own", async () => {
    const probes = corpus(["faqs"]);
    expect(await corpusEmbedding(config, probes)).toBe("stale");
    expect(probes.hasStale).toHaveBeenCalledWith("docs", "current");
    expect(probes.hasStale).toHaveBeenCalledWith("faqs", "faq-model");
    expect(probes.embedding).not.toHaveBeenCalled();
  });

  test("a corpus wholly on its declared models is current", async () => {
    expect(await corpusEmbedding(config, corpus([]))).toBe("current");
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
    const health = vectorHealth(config, () => corpus(["docs"]));
    expect(await health.read(context({ [VECTOR_PROVISIONED_VAR]: JSON.stringify(record) }))).toEqual({
      [VECTOR_CORPUS_EMBEDDING]: "stale",
      [UNPROVISIONED_VECTOR_INDEXES]: 1,
    });
  });

  test("an unreadable record throws, so the seam reports the summary unavailable rather than a zero", async () => {
    const health = vectorHealth(config, () => corpus([]));
    await expect(health.read(context({ [VECTOR_PROVISIONED_VAR]: "{not json" }))).rejects.toThrow();
  });
});

describe("the health summary on the manifest (#730)", () => {
  // The real capability, through the seam's own assembly check and per-caller read.
  const source = capabilityHealthSources([vector({ indexes: { docs: { model: "m", dimensions: 3 } } })]).get("vector");

  test("passes the seam's assembly check: both keys sit behind a scope vector's own admin route requires", () => {
    expect(source?.keys.map((key) => key.key)).toEqual([VECTOR_CORPUS_EMBEDDING, UNPROVISIONED_VECTOR_INDEXES]);
  });

  test("a caller without vector:indexes:read gets no value rather than a zero, and nothing is read", async () => {
    const produce = vi.fn(async () => ({ [VECTOR_CORPUS_EMBEDDING]: "current", [UNPROVISIONED_VECTOR_INDEXES]: 0 }));
    expect(await readCapabilityHealth(source, ["manifest:read"], produce)).toEqual({ state: "withheld" });
    expect(produce).not.toHaveBeenCalled();
  });

  test("a caller with it gets both values, zero included", async () => {
    const produce = async () => ({ [VECTOR_CORPUS_EMBEDDING]: "current", [UNPROVISIONED_VECTOR_INDEXES]: 2 });
    expect(await readCapabilityHealth(source, [VECTOR_INDEXES_READ_SCOPE], produce)).toEqual({
      state: "reported",
      values: { [VECTOR_CORPUS_EMBEDDING]: "current", [UNPROVISIONED_VECTOR_INDEXES]: 2 },
    });
  });
});
