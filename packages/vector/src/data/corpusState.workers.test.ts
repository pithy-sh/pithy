// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { vector_0001_documents } from "../migrations/0001_documents";
import { staleProbe, vectorCorpusState } from "./corpusState";
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

  test("hasStale answers whether any row is off the declared model, scoped to one index", async () => {
    expect(await corpus().hasStale("docs", "current")).toBe(false);
    await documents().put([document("a", { model: "current" }), document("b", { indexName: "faqs", model: "old" })]);
    expect(await corpus().hasStale("docs", "current")).toBe(false);
    expect(await corpus().hasStale("faqs", "current")).toBe(true);
    // Either side of the declared model in sort order, and a row never embedded, are each stale.
    for (const model of ["aaa-earlier", "zzz-later", null]) {
      await env.DB.exec("DELETE FROM pithy_vector_documents");
      await documents().put([document("a", { model: "current" }), document("b", { model })]);
      expect(await corpus().hasStale("docs", "current")).toBe(true);
    }
  });

  test("hasStale is three seeks on the (indexName, model) index, each stopped at its first row, and no scan", async () => {
    // What makes the health key `indexed`: the rows it reads are bounded by declarations, never by the
    // corpus. A count over the same index walks every entry for the index name; these probes stop at one.
    const compiled = staleProbe(vectorDatabase(env.DB), "docs", "current").compile();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
      .bind(...compiled.parameters)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    // `CamelCasePlugin` snake-cases the names, so the plan reads `pithy_vector_documents_model_idx`.
    const searches = details.filter((detail) => detail.includes("pithy_vector_documents_model_idx"));
    expect(searches).toEqual([
      expect.stringMatching(/^SEARCH .*\(index_name=\? AND model=\?\)$/),
      expect.stringMatching(/^SEARCH .*\(index_name=\? AND model<\?\)$/),
      expect.stringMatching(/^SEARCH .*\(index_name=\? AND model>\?\)$/),
    ]);
    // The only scan is SQLite's constant row for a select with no `FROM`. None touches the corpus.
    expect(details.filter((detail) => detail.includes("pithy_vector_documents") && detail.startsWith("SCAN"))).toEqual(
      [],
    );
    expect(compiled.sql.match(/limit \?/g)).toHaveLength(3);
  });
});
