// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { vector_0001_documents } from "../migrations/0001_documents";
import { vectorCorpusState } from "./corpusState";
import type { VectorDocument } from "./document";
import { vectorDocuments } from "./documents";
import { vectorDatabase } from "./tables";

/**
 * The corpus breakdown against real D1 in Miniflare — never a mock. What is being proved is that the counts
 * are the ones `pithy vector reprocess` would act on: a row on the declared model is current, a row on any
 * other is stale, a row with no model was never embedded, and every count is scoped to one index.
 */

const corpus = () => vectorCorpusState(vectorDatabase(env.DB));
const documents = () => vectorDocuments(vectorDatabase(env.DB));

const at = new Date("2026-07-01T12:00:00.000Z");

function document(id: string, overrides: Partial<VectorDocument> = {}): VectorDocument {
  return {
    id,
    indexName: "docs",
    namespace: null,
    content: `content for ${id}`,
    metadata: {},
    model: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_vector_documents");
  await vector_0001_documents.up(vectorDatabase(env.DB) as unknown as Kysely<unknown>);
});

describe("vectorCorpusState (#730)", () => {
  test("an empty index is all zeros, which is a reading and not an absence", async () => {
    expect(await corpus().embedding("docs", "current")).toEqual({ declaredModel: 0, otherModel: 0, unembedded: 0 });
    expect(await corpus().namespaces("docs")).toBe(0);
  });

  test("splits the corpus by the declared model, another model, and none", async () => {
    await documents().put([
      document("a", { model: "current" }),
      document("b", { model: "current" }),
      document("c", { model: "old" }),
      document("d", { model: "older" }),
      document("e"),
    ]);
    expect(await corpus().embedding("docs", "current")).toEqual({ declaredModel: 2, otherModel: 2, unembedded: 1 });
  });

  test("counts only the named index — the same ids in another index are another corpus", async () => {
    await documents().put([
      document("a", { model: "current" }),
      document("a", { indexName: "faqs", model: "old" }),
      document("b", { indexName: "faqs" }),
    ]);
    expect(await corpus().embedding("docs", "current")).toEqual({ declaredModel: 1, otherModel: 0, unembedded: 0 });
    expect(await corpus().embedding("faqs", "current")).toEqual({ declaredModel: 0, otherModel: 1, unembedded: 1 });
  });

  test("counts distinct namespaces and returns no name, and the default namespace is not one", async () => {
    await documents().put([
      document("a", { namespace: "org-1" }),
      document("b", { namespace: "org-1" }),
      document("c", { namespace: "org-2" }),
      document("d"),
      document("e", { indexName: "faqs", namespace: "org-3" }),
    ]);
    const namespaces = await corpus().namespaces("docs");
    expect(namespaces).toBe(2);
    expect(typeof namespaces).toBe("number");
  });
});
