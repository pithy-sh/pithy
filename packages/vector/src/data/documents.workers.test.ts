// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS } from "@pithy-sh/core/src/data/boundParameters";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { CamelCasePlugin, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { beforeEach, describe, expect, test } from "vitest";
import { vector_0001_documents } from "../migrations/0001_documents";
import type { VectorDocument } from "./document";
import { vectorDocuments } from "./documents";
import { type VectorDatabase, type VectorTables, vectorDatabase } from "./tables";

/**
 * The corpus store against real D1 in Miniflare — never a mock. What is being proved is the codec round trip
 * through actual SQLite (a `Date` out is the `Date` that went in, metadata survives as an object), the
 * keyset page's ordering and predicate, and that `markEmbedded` is the write that makes a row stop being
 * stale.
 */

const store = () => vectorDocuments(vectorDatabase(env.DB));

/**
 * The same database, wired to record how many parameters each statement bound.
 *
 * Miniflare does throw `too many SQL variables` past the cap today, but that is its SQLite build's limit
 * happening to match D1's — a runtime bump could raise it and disarm these tests without anyone noticing.
 * Counting the parameters asserts the limit we actually mean, on the statements the store actually issues,
 * so adding a `where` to one of them fails here rather than in production.
 */
function recordingStore(bound: number[]) {
  const db = new Kysely<DatabaseSchema<VectorTables>>({
    dialect: new D1Dialect({ database: env.DB }),
    plugins: [new CamelCasePlugin()],
    log: (event) => {
      if (event.level === "query") bound.push(event.query.parameters.length);
    },
  }) as unknown as VectorDatabase;
  return vectorDocuments(db);
}

const at = new Date("2026-07-01T12:00:00.000Z");

function document(id: string, overrides: Partial<VectorDocument> = {}): VectorDocument {
  return {
    id,
    indexName: "docs",
    namespace: null,
    content: `content for ${id}`,
    metadata: { ownerId: "ada" },
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

describe("vectorDocuments", () => {
  test("round-trips a document through the table's codecs", async () => {
    const written = document("a", { namespace: "tenant-1", metadata: { ownerId: "ada", rank: 3, live: true } });
    await store().put([written]);
    expect(await store().get("docs", "a")).toEqual(written);
  });

  test("put is idempotent — the same id replaces rather than duplicates", async () => {
    await store().put([document("a")]);
    await store().put([document("a", { content: "revised" })]);
    const page = await store().page({ indexName: "docs", after: null, limit: 10 });
    expect(page).toHaveLength(1);
    expect(page[0]?.content).toBe("revised");
  });

  test("the same id in two indexes is two documents — neither write displaces the other", async () => {
    await store().put([document("intro", { content: "the docs intro" })]);
    await store().put([document("intro", { indexName: "faqs", content: "the faqs intro" })]);

    expect((await store().get("docs", "intro"))?.content).toBe("the docs intro");
    expect((await store().get("faqs", "intro"))?.content).toBe("the faqs intro");
  });

  test("markEmbedded stamps one index's row, leaving the same id in another index alone", async () => {
    const later = new Date("2026-07-02T00:00:00.000Z");
    await store().put([document("intro"), document("intro", { indexName: "faqs" })]);

    await store().markEmbedded("docs", ["intro"], "current-model", later);

    expect((await store().get("docs", "intro"))?.model).toBe("current-model");
    expect((await store().get("faqs", "intro"))?.model).toBeNull();
  });

  test("remove takes one index's row and leaves the same id in another index", async () => {
    await store().put([document("intro"), document("intro", { indexName: "faqs" })]);

    expect(await store().remove("docs", "intro")).toBe(true);
    expect(await store().get("docs", "intro")).toBeNull();
    expect((await store().get("faqs", "intro"))?.content).toBe("content for intro");
  });

  test("scopes every read to one index", async () => {
    await store().put([document("a"), document("b", { indexName: "notes" })]);
    expect(await store().get("docs", "b")).toBeNull();
    expect((await store().page({ indexName: "docs", after: null, limit: 10 })).map((d) => d.id)).toEqual(["a"]);
  });

  test("pages by keyset in id order, so a page cannot skip or repeat", async () => {
    await store().put([document("a"), document("b"), document("c")]);
    const first = await store().page({ indexName: "docs", after: null, limit: 2 });
    expect(first.map((d) => d.id)).toEqual(["a", "b"]);
    const second = await store().page({ indexName: "docs", after: "b", limit: 2 });
    expect(second.map((d) => d.id)).toEqual(["c"]);
  });

  test("the stale-model page selects rows with no model and rows on another model", async () => {
    await store().put([
      document("a"),
      document("b", { model: "old-model" }),
      document("c", { model: "current-model" }),
    ]);
    const stale = await store().page({ indexName: "docs", after: null, limit: 10, staleModel: "current-model" });
    expect(stale.map((d) => d.id)).toEqual(["a", "b"]);
  });

  test("markEmbedded stamps the model and the timestamp, so the row stops being stale", async () => {
    const later = new Date("2026-07-02T00:00:00.000Z");
    await store().put([document("a"), document("b")]);
    await store().markEmbedded("docs", ["a"], "current-model", later);

    const marked = await store().get("docs", "a");
    expect(marked?.model).toBe("current-model");
    expect(marked?.updatedAt).toEqual(later);
    expect(marked?.createdAt).toEqual(at);

    const stale = await store().page({ indexName: "docs", after: null, limit: 10, staleModel: "current-model" });
    expect(stale.map((d) => d.id)).toEqual(["b"]);
  });

  test("byIds hydrates a query's matches and reports nothing for an id the corpus has lost", async () => {
    await store().put([document("a"), document("b")]);
    const hydrated = await store().byIds("docs", ["b", "missing", "a"]);
    expect(hydrated.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  test("remove reports whether there was a row to remove", async () => {
    await store().put([document("a")]);
    expect(await store().remove("docs", "a")).toBe(true);
    expect(await store().remove("docs", "a")).toBe(false);
  });

  test("empty inputs touch nothing", async () => {
    await store().put([]);
    await store().markEmbedded("docs", [], "current-model", at);
    expect(await store().byIds("docs", [])).toEqual([]);
  });
});

describe("D1's bound-parameter cap", () => {
  /** Past one full chunk, so the union across chunks is exercised rather than assumed. */
  const ids = Array.from({ length: 150 }, (_, index) => `doc-${String(index).padStart(4, "0")}`);

  beforeEach(async () => {
    await store().put(ids.map((id) => document(id)));
  });

  test("byIds stays under the cap — a topK of 100 matches binds the index name too", async () => {
    const bound: number[] = [];
    const hydrated = await recordingStore(bound).byIds("docs", ids);

    // Every id comes back, so chunking splits the work without dropping any of it.
    expect(hydrated.map((doc) => doc.id).sort()).toEqual([...ids].sort());
    expect(bound.length).toBeGreaterThan(1);
    expect(Math.max(...bound)).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });

  test("the maximum topK a query can ask for no longer overflows the hydration", async () => {
    const bound: number[] = [];
    const hydrated = await recordingStore(bound).byIds("docs", ids.slice(0, 100));

    expect(hydrated).toHaveLength(100);
    expect(Math.max(...bound)).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });

  test("markEmbedded stays under the cap — its `set` clause and index scope bind three before a single id", async () => {
    const later = new Date("2026-07-03T00:00:00.000Z");
    const bound: number[] = [];
    await recordingStore(bound).markEmbedded("docs", ids, "current-model", later);

    expect(bound.length).toBeGreaterThan(1);
    expect(Math.max(...bound)).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    // And every row was actually stamped: nothing is left stale behind a chunk boundary.
    const stale = await store().page({
      indexName: "docs",
      after: null,
      limit: ids.length,
      staleModel: "current-model",
    });
    expect(stale).toEqual([]);
  });
});
