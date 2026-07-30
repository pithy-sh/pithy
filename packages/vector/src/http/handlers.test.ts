// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import type { VectorIndexConfig } from "../config/config";
import type { VectorDocument } from "../data/document";
import type { DocumentStore } from "../data/documents";
import type { VectorAi } from "../embed/embed";
import type { VectorStore, VectorUpsert } from "../index/index";
import { deleteDocument, getDocument, type HandlerDeps, queryDocuments, upsertDocuments } from "./handlers";
import { UpsertDocumentsInput } from "./schemas";

/**
 * The handlers against fakes, with no Worker and no network — the only way to test anything that touches
 * Vectorize or Workers AI, neither of which Cloudflare emulates locally.
 *
 * The assertions that matter are about **order**: a document reaches D1 before Vectorize, its `model` is
 * stamped only after the vector is accepted, and a delete leaves the index before it leaves the corpus.
 * Each of those, done the other way round, produces a corpus or an index that cannot be repaired.
 */

const index: VectorIndexConfig = { model: "current-model", dimensions: 3, metric: "cosine", binding: "VECTORIZE" };
const at = new Date("2026-07-01T00:00:00.000Z");

/** Every call any fake receives, in the order it happened — the trace the ordering assertions read. */
type Trace = string[];

function fakeDocuments(trace: Trace, seed: VectorDocument[] = []) {
  const rows = new Map(seed.map((row) => [row.id, row]));
  const store: DocumentStore & { rows: Map<string, VectorDocument> } = {
    rows,
    async put(documents) {
      trace.push(`d1:put:${documents.map((d) => d.id).join(",")}`);
      for (const row of documents) rows.set(row.id, row);
    },
    async get(_indexName, id) {
      return rows.get(id) ?? null;
    },
    async byIds(_indexName, ids) {
      return ids.flatMap((id) => (rows.has(id) ? [rows.get(id) as VectorDocument] : []));
    },
    async remove(_indexName, id) {
      trace.push(`d1:remove:${id}`);
      return rows.delete(id);
    },
    async page() {
      return [];
    },
    async markEmbedded(indexName, ids, model) {
      trace.push(`d1:mark:${indexName}:${ids.join(",")}:${model}`);
      for (const id of ids) {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, model });
      }
    },
  };
  return store;
}

function fakeAi(): VectorAi {
  return {
    async run(_model, input) {
      const batch = (input as { text: string[] }).text;
      return { data: batch.map(() => [1, 2, 3]) };
    },
  };
}

function fakeStore(trace: Trace, matches: { id: string; score: number }[] = []) {
  const store: VectorStore & { upserts: VectorUpsert[] } = {
    upserts: [],
    async upsert(vectors) {
      trace.push(`vec:upsert:${vectors.map((v) => v.id).join(",")}`);
      store.upserts.push(...vectors);
      return { mutationId: "mutation-1" };
    },
    async query(_vector, options) {
      trace.push(`vec:query:${JSON.stringify(options)}`);
      return { count: matches.length, matches };
    },
    async deleteByIds(ids) {
      trace.push(`vec:delete:${ids.join(",")}`);
      return { mutationId: "mutation-2" };
    },
  };
  return store;
}

function deps(overrides: Partial<HandlerDeps> = {}, trace: Trace = []): HandlerDeps {
  return {
    documents: fakeDocuments(trace),
    store: fakeStore(trace),
    ai: fakeAi(),
    index,
    indexName: "docs",
    filterable: [{ propertyName: "ownerId", indexType: "string" }],
    defaultTopK: 10,
    newId: () => "generated-id",
    now: () => at,
    ...overrides,
  };
}

function document(id: string, overrides: Partial<VectorDocument> = {}): VectorDocument {
  return {
    id,
    indexName: "docs",
    namespace: null,
    content: `text ${id}`,
    metadata: { ownerId: "ada" },
    model: "current-model",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("upsertDocuments", () => {
  it("embeds text with the index's pinned model and writes the vector and the document", async () => {
    const trace: Trace = [];
    const store = fakeStore(trace);
    const result = await upsertDocuments(deps({ store }, trace), { text: "hello", metadata: { ownerId: "ada" } });

    expect(result.ids).toEqual(["generated-id"]);
    expect(result.mutationId).toBe("mutation-1");
    expect(store.upserts[0]).toEqual({ id: "generated-id", values: [1, 2, 3], metadata: { ownerId: "ada" } });
  });

  it("writes D1 first and stamps the model only after Vectorize accepts the vector", async () => {
    const trace: Trace = [];
    await upsertDocuments(deps({}, trace), { text: "hello" });
    // The stamp carries the index: an id names a row only together with the index it belongs to.
    expect(trace).toEqual([
      "d1:put:generated-id",
      "vec:upsert:generated-id",
      "d1:mark:docs:generated-id:current-model",
    ]);
  });

  it("leaves the row unstamped when Vectorize refuses, so the default reprocess pass picks it up", async () => {
    const trace: Trace = [];
    const documents = fakeDocuments(trace);
    const refusing: VectorStore = {
      async upsert() {
        throw new Error("vectorize is down");
      },
      async query() {
        return { count: 0, matches: [] };
      },
    };
    await expect(upsertDocuments(deps({ documents, store: refusing }, trace), { text: "hello" })).rejects.toThrow();
    expect(documents.rows.get("generated-id")?.model).toBeNull();
    expect(documents.rows.get("generated-id")?.content).toBe("hello");
  });

  it("accepts a batch, and a supplied id makes the write idempotent", async () => {
    const trace: Trace = [];
    const store = fakeStore(trace);
    const result = await upsertDocuments(deps({ store }, trace), {
      documents: [
        { id: "a", text: "one" },
        { id: "b", values: [4, 5, 6] },
      ],
    });
    expect(result.ids).toEqual(["a", "b"]);
    expect(store.upserts.map((v) => v.values)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("falls back to the index's namespace and records it on the row", async () => {
    const trace: Trace = [];
    const documents = fakeDocuments(trace);
    await upsertDocuments(deps({ documents, index: { ...index, namespace: "tenant-1" } }, trace), { text: "hello" });
    expect(documents.rows.get("generated-id")?.namespace).toBe("tenant-1");
  });

  // The two shape rules below moved off the handler and onto the route line — `zValidator("json",
  // UpsertDocumentsInput, validationHook)` answers them with a `validation/invalid_input` 400 before a
  // handler runs (pinned over HTTP in routes.test.ts). The handler now takes an already-validated value, so
  // the rule is asserted where it is now enforced: on the schema.
  it("refuses a document that names both text and values — two sources for one vector", () => {
    expect(UpsertDocumentsInput.safeParse({ text: "hello", values: [1, 2, 3] }).success).toBe(false);
  });

  it("refuses a document that names neither", () => {
    expect(UpsertDocumentsInput.safeParse({ metadata: {} }).success).toBe(false);
  });

  it("refuses a precomputed vector of the wrong size, before it reaches the index", async () => {
    const error = await upsertDocuments(deps(), { values: [1, 2] }).catch((e: unknown) => e);
    expect((error as PithyError).payload.code).toBe("vector/dimension_mismatch");
  });
});

describe("queryDocuments", () => {
  it("hydrates matches from the corpus, keeping Vectorize's score order", async () => {
    const trace: Trace = [];
    const documents = fakeDocuments(trace, [document("b"), document("a")]);
    const store = fakeStore(trace, [
      { id: "b", score: 0.9 },
      { id: "a", score: 0.4 },
    ]);
    const result = await queryDocuments(deps({ documents, store }, trace), { text: "hello" });

    expect(result.count).toBe(2);
    expect(result.matches.map((m) => m.id)).toEqual(["b", "a"]);
    expect(result.matches[0]?.document?.content).toBe("text b");
  });

  it("reports a match the corpus has lost as a null document rather than dropping it", async () => {
    const trace: Trace = [];
    const store = fakeStore(trace, [{ id: "gone", score: 0.7 }]);
    const result = await queryDocuments(deps({ store }, trace), { text: "hello" });
    expect(result.matches).toEqual([{ id: "gone", score: 0.7, document: null }]);
  });

  it("applies the configured defaultTopK and asks for no payload, which keeps the ceiling at 100", async () => {
    const trace: Trace = [];
    await queryDocuments(deps({ defaultTopK: 7 }, trace), { text: "hello" });
    expect(trace).toContain('vec:query:{"topK":7,"returnValues":false,"returnMetadata":false}');
  });

  it("refuses a filter on a field with no metadata index", async () => {
    const error = await queryDocuments(deps(), { text: "hello", filter: { title: "x" } }).catch((e: unknown) => e);
    expect((error as PithyError).payload.code).toBe("vector/unfilterable_field");
  });

  it("compiles a filter over an indexed field and hands it to Vectorize", async () => {
    const trace: Trace = [];
    await queryDocuments(deps({}, trace), { text: "hello", filter: { ownerId: "ada" } });
    expect(trace.join(" ")).toContain('"filter":{"ownerId":{"$eq":"ada"}}');
  });
});

describe("getDocument", () => {
  it("returns the hydrated document", async () => {
    const trace: Trace = [];
    const documents = fakeDocuments(trace, [document("a")]);
    expect((await getDocument(deps({ documents }, trace), "a")).content).toBe("text a");
  });

  it("is a 404 for an id the corpus does not have", async () => {
    const error = await getDocument(deps(), "missing").catch((e: unknown) => e);
    expect((error as PithyError).payload.status).toBe(404);
  });
});

describe("deleteDocument", () => {
  it("leaves the index before it leaves the corpus, so a failure never orphans a vector", async () => {
    const trace: Trace = [];
    const documents = fakeDocuments(trace, [document("a")]);
    const result = await deleteDocument(deps({ documents }, trace), "a");

    expect(result).toEqual({ id: "a", mutationId: "mutation-2" });
    expect(trace).toEqual(["vec:delete:a", "d1:remove:a"]);
  });

  it("is a 404 for an unknown id, so no mutation is enqueued against nothing", async () => {
    const trace: Trace = [];
    await expect(deleteDocument(deps({}, trace), "missing")).rejects.toBeInstanceOf(PithyError);
    expect(trace).toEqual([]);
  });
});
