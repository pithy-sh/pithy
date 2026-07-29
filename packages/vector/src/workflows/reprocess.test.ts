import { describe, expect, it } from "vitest";
import type { VectorIndexConfig } from "../config/config";
import type { VectorDocument } from "../data/document";
import type { DocumentPageRequest, DocumentStore } from "../data/documents";
import type { VectorAi } from "../embed/embed";
import type { VectorStore, VectorUpsert } from "../index/index";
import { type ReprocessStep, reprocessIndex } from "./reprocess";

/**
 * Reprocess is tested entirely against fakes and no network — Cloudflare ships no local emulation for
 * Vectorize or Workers AI, so injection is the only way any of this is testable at all.
 *
 * The test that matters is the resume: a run is killed mid-corpus and restarted against the same journal,
 * and every document must be embedded exactly once across both runs. A skip is a document that silently
 * stops matching searches; a duplicate is wasted spend on a model call. Neither errors on its own.
 */

const index: VectorIndexConfig = { model: "current-model", dimensions: 3, metric: "cosine", binding: "VECTORIZE" };

const at = new Date("2026-07-01T00:00:00.000Z");

function document(id: string, overrides: Partial<VectorDocument> = {}): VectorDocument {
  return {
    id,
    indexName: "docs",
    namespace: null,
    content: `text ${id}`,
    metadata: { ownerId: "ada" },
    model: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** An in-memory corpus with the same keyset and stale-model semantics the D1 store proves in Miniflare. */
function fakeDocuments(seed: VectorDocument[]): DocumentStore & { rows: Map<string, VectorDocument> } {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  return {
    rows,
    async put(documents) {
      for (const row of documents) rows.set(row.id, { ...row });
    },
    async get(indexName, id) {
      const row = rows.get(id);
      return row && row.indexName === indexName ? row : null;
    },
    async byIds(indexName, ids) {
      return ids.flatMap((id) => {
        const row = rows.get(id);
        return row && row.indexName === indexName ? [row] : [];
      });
    },
    async remove(_indexName, id) {
      return rows.delete(id);
    },
    async page(request: DocumentPageRequest) {
      return [...rows.values()]
        .filter((row) => row.indexName === request.indexName)
        .filter((row) => request.after === null || row.id > request.after)
        .filter((row) => request.staleModel === undefined || row.model !== request.staleModel)
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .slice(0, request.limit);
    },
    async markEmbedded(_indexName, ids, model, when) {
      for (const id of ids) {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, model, updatedAt: when });
      }
    },
  };
}

/** A Workers AI stand-in: one deterministic vector per text, and a record of every call. */
function fakeAi(): VectorAi & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async run(_model, input) {
      const batch = (input as { text: string[] }).text;
      for (const text of batch) texts.push(text);
      return { data: batch.map(() => [0.1, 0.2, 0.3]) };
    },
  };
}

/** A Vectorize stand-in recording every id it was asked to write. */
function fakeStore(): VectorStore & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    async upsert(vectors: VectorUpsert[]) {
      for (const vector of vectors) written.push(vector.id);
      return { mutationId: "m1" };
    },
    async query() {
      return { count: 0, matches: [] };
    },
  };
}

/**
 * A journalled step runner, which is what a Cloudflare Workflow is: a completed step's result is replayed
 * from the journal rather than re-run. `failOnCall` makes the instance die partway, exactly as a timeout or
 * an evicted isolate would.
 */
function journalledStep(journal: Map<string, unknown>, failOnCall?: number): ReprocessStep & { ran: string[] } {
  const ran: string[] = [];
  let call = 0;
  return {
    ran,
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      if (journal.has(name)) return journal.get(name) as T;
      call += 1;
      if (failOnCall !== undefined && call >= failOnCall) throw new Error("instance died");
      ran.push(name);
      const result = await callback();
      journal.set(name, result);
      return result;
    },
  };
}

function deps(documents: DocumentStore, ai: VectorAi, store: VectorStore) {
  return { documents, store, ai, index, indexName: "docs", now: () => at };
}

describe("reprocessIndex", () => {
  it("re-embeds only the documents whose model drifted", async () => {
    const documents = fakeDocuments([
      document("a", { model: "old-model" }),
      document("b", { model: "current-model" }),
      document("c"),
    ]);
    const store = fakeStore();
    const report = await reprocessIndex(deps(documents, fakeAi(), store), journalledStep(new Map()));

    expect(store.written).toEqual(["a", "c"]);
    expect(report.reembedded).toBe(2);
    expect(documents.rows.get("a")?.model).toBe("current-model");
  });

  it("re-embeds the whole corpus when asked, model or not", async () => {
    const documents = fakeDocuments([document("a", { model: "current-model" }), document("b")]);
    const store = fakeStore();
    await reprocessIndex(deps(documents, fakeAi(), store), journalledStep(new Map()), { all: true });
    expect(store.written).toEqual(["a", "b"]);
  });

  it("narrows the run with a metadata filter, evaluated against the corpus rows", async () => {
    const documents = fakeDocuments([
      document("a", { metadata: { ownerId: "ada" } }),
      document("b", { metadata: { ownerId: "grace" } }),
    ]);
    const store = fakeStore();
    const report = await reprocessIndex(deps(documents, fakeAi(), store), journalledStep(new Map()), {
      filter: { ownerId: { $eq: "grace" } },
    });

    expect(store.written).toEqual(["b"]);
    expect(report.scanned).toBe(2);
    expect(report.reembedded).toBe(1);
  });

  it("skips a row the corpus holds no text for — there is nothing to embed", async () => {
    const documents = fakeDocuments([document("a", { content: null }), document("b")]);
    const store = fakeStore();
    const report = await reprocessIndex(deps(documents, fakeAi(), store), journalledStep(new Map()));

    expect(store.written).toEqual(["b"]);
    expect(report.skipped).toBe(1);
  });

  it("walks the corpus one page per step, and each step is named for its page", async () => {
    const documents = fakeDocuments(["a", "b", "c", "d", "e"].map((id) => document(id)));
    const store = fakeStore();
    const step = journalledStep(new Map());
    const report = await reprocessIndex(deps(documents, fakeAi(), store), step, { pageSize: 2 });

    expect(store.written).toEqual(["a", "b", "c", "d", "e"]);
    // Three full-ish pages: [a,b], [c,d], [e] — the last is short, which ends the run.
    expect(step.ran).toEqual(["page-000001", "page-000002", "page-000003"]);
    expect(report.pages).toBe(3);
    expect(report.scanned).toBe(5);
  });

  it("resumes from the journal without duplicating or skipping a single document", async () => {
    const documents = fakeDocuments(["a", "b", "c", "d", "e", "f"].map((id) => document(id)));
    const store = fakeStore();
    const journal = new Map<string, unknown>();

    // The instance dies on its third step, after two pages have been journalled.
    await expect(
      reprocessIndex(deps(documents, fakeAi(), store), journalledStep(journal, 3), { pageSize: 2 }),
    ).rejects.toThrow("instance died");
    expect(store.written).toEqual(["a", "b", "c", "d"]);

    // Cloudflare restarts it. Journalled steps replay; the run continues where it stopped.
    const resumed = journalledStep(journal);
    const report = await reprocessIndex(deps(documents, fakeAi(), store), resumed, { pageSize: 2 });

    // Exactly once each, in corpus order — no page re-run, no page missed.
    expect(store.written).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(resumed.ran).toEqual(["page-000003", "page-000004"]);
    expect(report.scanned).toBe(6);
    expect(report.reembedded).toBe(6);
  });

  it("does not skip when the model stamp shrinks the result set underneath the scan", async () => {
    // The default pass rewrites the very rows it selects. With offset pagination page two would start at row
    // 2 of a set that just lost its first two members; keyset order cannot.
    const documents = fakeDocuments(["a", "b", "c", "d"].map((id) => document(id)));
    const store = fakeStore();
    await reprocessIndex(deps(documents, fakeAi(), store), journalledStep(new Map()), { pageSize: 2 });
    expect(store.written).toEqual(["a", "b", "c", "d"]);
  });

  it("caps a page at Vectorize's upsert ceiling however large a page size is asked for", async () => {
    const documents = fakeDocuments(["a"].map((id) => document(id)));
    const store = fakeStore();
    const pages: number[] = [];
    const spy: DocumentStore = {
      ...documents,
      page: async (request) => {
        pages.push(request.limit);
        return documents.page(request);
      },
    };
    await reprocessIndex(deps(spy, fakeAi(), store), journalledStep(new Map()), { pageSize: 50_000 });
    expect(pages).toEqual([1000]);
  });

  it("embeds with the index's pinned model, never a default", async () => {
    const documents = fakeDocuments([document("a")]);
    const ai = fakeAi();
    const models: string[] = [];
    const recording: VectorAi = {
      run: (model, input) => {
        models.push(model);
        return ai.run(model, input);
      },
    };
    await reprocessIndex(deps(documents, recording, fakeStore()), journalledStep(new Map()));
    expect(models).toEqual(["current-model"]);
  });
});
