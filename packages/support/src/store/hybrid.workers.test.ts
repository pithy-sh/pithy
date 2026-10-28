// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { SupportConfig } from "../config/config";
import { supportDatabase } from "../data/tables";
import { embedMessage } from "../semantic/embed";
import { supportMessageIndex } from "../semantic/messageIndex";
import { freshSupportSchema, seedMessage, seedThread } from "../test-utils/seed";
import { fakeAi, fakeVectorStore } from "../test-utils/semantic";
import { type SearchDeps, type SearchThreadsQuery, searchThreads } from "./hybrid";
import { keywordHits } from "./search";
import { createSearchIndex } from "./searchIndex";

/**
 * Hybrid search against real D1 — both keyword backends on live rows, the semantic side on the fakes that stand
 * in for Workers AI and Vectorize, and the filters applied in SQL after retrieval.
 */

const db = supportDatabase(env.DB);
const T0 = 1_700_000_000_000;
const VIEWER = "viewer-1";
const index = (() => {
  const found = supportMessageIndex(SupportConfig.parse({ search: { semantic: true } }).search);
  if (!found) throw new Error("semantic: true must yield an index");
  return found;
})();

/** One thread holding one inbound message, embedded into the fake index when a store is given. */
async function seed(
  thread: Parameters<typeof seedThread>[1],
  message: { id: string; subject: string; body: string; receivedAt?: number },
  semantic?: { store: ReturnType<typeof fakeVectorStore> },
): Promise<void> {
  await seedThread(db, thread);
  await seedMessage(db, { ...message, threadId: thread.id, receivedAt: message.receivedAt ?? thread.lastMessageAt });
  if (semantic) {
    await embedMessage(
      { db, ai: fakeAi(index.dimensions), store: semantic.store, index, now: () => new Date(T0) },
      message.id,
    );
  }
}

function search(deps: Partial<SearchDeps>, query: SearchThreadsQuery) {
  return searchThreads({ db, fts: false, viewer: VIEWER, ...deps }, query);
}

const threads = (outcome: { results: { thread: { id: string } }[] }) => outcome.results.map((r) => r.thread.id);

beforeEach(async () => {
  await freshSupportSchema(env.DB);
});

describe("keywordHits — the LIKE scan", () => {
  beforeEach(async () => {
    await seed(
      { id: "refund", lastMessageAt: T0 + 300 },
      { id: "m1", subject: "Money problem", body: "I was charged twice" },
    );
    await seed(
      { id: "login", lastMessageAt: T0 + 200 },
      { id: "m2", subject: "Cannot log in", body: "the link never arrived" },
    );
  });

  test("finds a word in a body and a word in a subject", async () => {
    expect(await keywordHits(db, "charged", { backend: "like", limit: 10 })).toEqual([
      { messageId: "m1", threadId: "refund" },
    ]);
    expect((await keywordHits(db, "Cannot log", { backend: "like", limit: 10 })).map((hit) => hit.threadId)).toEqual([
      "login",
    ]);
  });

  test("a term containing % matches a literal percent sign", async () => {
    await seed(
      { id: "discount", lastMessageAt: T0 + 400 },
      { id: "m3", subject: "Coupon", body: "the 50% code was refused" },
    );
    await seed(
      { id: "invoice", lastMessageAt: T0 + 100 },
      { id: "m4", subject: "Invoice", body: "line item 5000 is wrong" },
    );
    expect((await keywordHits(db, "50%", { backend: "like", limit: 10 })).map((hit) => hit.threadId)).toEqual([
      "discount",
    ]);
  });

  test("has no score, and ranks by recency, newest first", async () => {
    await seed({ id: "newer", lastMessageAt: T0 + 900 }, { id: "m5", subject: "Again", body: "charged again" });
    const hits = await keywordHits(db, "charged", { backend: "like", limit: 10 });
    expect(hits.map((hit) => hit.messageId)).toEqual(["m5", "m1"]);
    expect(hits.every((hit) => hit.score === undefined)).toBe(true);
  });
});

describe("keywordHits — FTS5", () => {
  beforeEach(async () => {
    await createSearchIndex(db);
  });

  test("ranks by bm25 and reports it raw", async () => {
    await seed({ id: "t1", lastMessageAt: T0 }, { id: "m1", subject: "Refund", body: "charged twice, charged again" });
    await seed({ id: "t2", lastMessageAt: T0 + 1 }, { id: "m2", subject: "Hi", body: "I was charged" });
    const hits = await keywordHits(db, "charged", { backend: "fts", limit: 10 });
    expect(hits.map((hit) => hit.messageId)).toEqual(["m1", "m2"]);
    expect(typeof hits[0]?.score).toBe("number");
    expect(hits[0]?.score as number).toBeLessThan(hits[1]?.score as number);
  });

  test("FTS5 operator syntax in a query is searched for, never obeyed", async () => {
    await seed({ id: "literal", lastMessageAt: T0 + 300 }, { id: "m1", subject: "Terms", body: "alpha NOT beta" });
    await seed({ id: "other", lastMessageAt: T0 + 200 }, { id: "m2", subject: "Terms", body: "alpha gamma" });
    expect((await keywordHits(db, "alpha NOT beta", { backend: "fts", limit: 10 })).map((h) => h.threadId)).toEqual([
      "literal",
    ]);
    expect(await keywordHits(db, "alpha OR gamma", { backend: "fts", limit: 10 })).toEqual([]);
  });

  test("a term that tokenizes to nothing matches nothing, never everything", async () => {
    await seed({ id: "t1", lastMessageAt: T0 }, { id: "m1", subject: "Refund", body: "charged" });
    expect(await keywordHits(db, "???", { backend: "fts", limit: 10 })).toEqual([]);
  });
});

describe("searchThreads", () => {
  let store: ReturnType<typeof fakeVectorStore>;
  let semantic: Partial<SearchDeps>;

  beforeEach(async () => {
    store = fakeVectorStore();
    semantic = { index, ai: fakeAi(index.dimensions), store };
    await seed(
      { id: "order", lastMessageAt: T0 + 100 },
      { id: "m-order", subject: "Where is ORD-40912", body: "My order ORD-40912 has not shipped yet." },
      { store },
    );
    await seed(
      { id: "upload", lastMessageAt: T0 + 200 },
      { id: "m-upload", subject: "Upload problem", body: "The file upload times out after thirty seconds." },
      { store },
    );
    await seed(
      { id: "shipping", lastMessageAt: T0 + 300 },
      { id: "m-ship", subject: "Shipping question", body: "When does my order ship? It has not shipped." },
      { store },
    );
  });

  /**
   * Real Vectorize returns its topK nearest neighbors whatever their score, and a model cannot retrieve an
   * identifier it has never seen — so semantic's answer to an order number is the other threads.
   */
  const unrelated = (from: ReturnType<typeof fakeVectorStore>) => ({
    ...from,
    query: async () => ({
      count: 2,
      matches: [
        { id: "m-ship", score: 0.41 },
        { id: "m-upload", score: 0.37 },
      ],
    }),
  });

  test("hybrid still finds an exact identifier first, with semantic on and missing it", async () => {
    const outcome = await search({ ...semantic, store: unrelated(store) }, { q: "ORD-40912" });
    expect(outcome.mode).toBe("hybrid");
    expect(outcome.ran).toEqual(["like", "semantic"]);
    expect(threads(outcome)[0]).toBe("order");
  });

  test("hybrid finds the exact identifier first over FTS5 too", async () => {
    await createSearchIndex(db);
    // The triggers index new writes; these rows predate the index, so index them the way provisioning does.
    const { reindexAll } = await import("./search");
    await reindexAll(db);
    const outcome = await search({ ...semantic, store: unrelated(store), fts: true }, { q: "ORD-40912" });
    expect(outcome.ran).toEqual(["fts", "semantic"]);
    expect(threads(outcome)[0]).toBe("order");
    expect(outcome.results[0]?.messageId).toBe("m-order");
    expect(typeof outcome.results[0]?.bm25).toBe("number");
    expect(outcome.results[0]?.similarity).toBeUndefined();
  });

  test("both scores are reported raw where both backends matched the same message", async () => {
    await createSearchIndex(db);
    const { reindexAll } = await import("./search");
    await reindexAll(db);
    const outcome = await search({ ...semantic, fts: true }, { q: "ORD-40912" });
    expect(outcome.results[0]?.messageId).toBe("m-order");
    expect(typeof outcome.results[0]?.bm25).toBe("number");
    expect(typeof outcome.results[0]?.similarity).toBe("number");
  });

  test("a paraphrase that shares no word with the message finds it in semantic and hybrid", async () => {
    const q = "uploads keep dying halfway";
    expect(threads(await search(semantic, { q, mode: "keyword" }))).toEqual([]);
    expect(threads(await search(semantic, { q, mode: "semantic" }))[0]).toBe("upload");
    const hybrid = await search(semantic, { q, mode: "hybrid" });
    expect(threads(hybrid)[0]).toBe("upload");
    expect(hybrid.results[0]?.similarity).toBeGreaterThan(0);
    // The keyword backend ran and did not match it, so there is no keyword score to report.
    expect(hybrid.results[0]?.bm25).toBeUndefined();
  });

  test("one thread with several matching messages appears once, named by its best message", async () => {
    await seedMessage(db, {
      id: "m-order-2",
      threadId: "order",
      subject: "Re",
      body: "Still no ORD-40912",
      receivedAt: T0 + 500,
    });
    const outcome = await search({}, { q: "ORD-40912", mode: "keyword" });
    expect(threads(outcome)).toEqual(["order"]);
    // The LIKE scan ranks by recency, so the newer message is the one that ranked the thread.
    expect(outcome.results[0]?.messageId).toBe("m-order-2");
  });

  test("filters apply after retrieval, and a filtered result reports its true count", async () => {
    await seed(
      { id: "order-archived", lastMessageAt: T0 + 400, archived: true },
      { id: "m-arch", subject: "ORD-40912 again", body: "ORD-40912" },
    );
    await seed(
      { id: "order-urgent", lastMessageAt: T0 + 50, priority: "urgent", assigneeRef: "ada" },
      { id: "m-urgent", subject: "ORD-40912 urgent", body: "ORD-40912" },
    );
    expect(threads(await search({}, { q: "ORD-40912", mode: "keyword" })).sort()).toEqual(["order", "order-urgent"]);
    expect(threads(await search({}, { q: "ORD-40912", mode: "keyword", archived: true }))).toEqual(["order-archived"]);
    const urgent = await search({}, { q: "ORD-40912", mode: "keyword", priority: "urgent", limit: 20 });
    expect(threads(urgent)).toEqual(["order-urgent"]);
    expect(urgent.results).toHaveLength(1);
    expect(threads(await search({}, { q: "ORD-40912", mode: "keyword", assignee: "none" }))).toEqual(["order"]);
  });

  test("the limit caps the threads, best first", async () => {
    for (let at = 0; at < 5; at += 1) {
      await seed(
        { id: `many-${at}`, lastMessageAt: T0 + 1000 + at },
        { id: `m-many-${at}`, subject: "refund", body: "refund please" },
      );
    }
    const outcome = await search({}, { q: "refund", mode: "keyword", limit: 3 });
    expect(threads(outcome)).toEqual(["many-4", "many-3", "many-2"]);
  });

  test("an explicit semantic or hybrid with search.semantic off is refused, naming the flag", async () => {
    for (const mode of ["semantic", "hybrid"] as const) {
      await expect(search({}, { q: "x", mode })).rejects.toMatchObject({
        payload: { code: "validation/invalid_input", message: expect.stringContaining("search.semantic") },
      });
    }
  });

  test("an omitted mode with semantic off runs keyword alone, and says so", async () => {
    const outcome = await search({}, { q: "ORD-40912" });
    expect(outcome).toMatchObject({ mode: "hybrid", ran: ["like"], skipped: [] });
  });

  test("a semantic backend that is on but unbound is skipped and named, never a 500", async () => {
    const outcome = await search({ index }, { q: "ORD-40912" });
    expect(outcome.ran).toEqual(["like"]);
    expect(outcome.skipped).toEqual([{ backend: "semantic", reason: "unprovisioned" }]);
    expect(threads(outcome)).toEqual(["order"]);
  });

  test("a model that does not answer is skipped as failed, and the keyword half still answers", async () => {
    const ai = fakeAi(index.dimensions);
    ai.fail = true;
    const outcome = await search({ index, ai, store }, { q: "ORD-40912" });
    expect(outcome.skipped).toEqual([{ backend: "semantic", reason: "failed" }]);
    expect(threads(outcome)).toEqual(["order"]);
  });

  test("FTS5 configured and not provisioned falls back to the LIKE scan, and names what it skipped", async () => {
    const outcome = await search({ fts: true }, { q: "ORD-40912", mode: "keyword" });
    expect(outcome.ran).toEqual(["like"]);
    expect(outcome.skipped).toEqual([{ backend: "fts", reason: "unprovisioned" }]);
    expect(threads(outcome)).toEqual(["order"]);
  });

  test("returns 20 threads by default and never more than 50, whatever a caller asks", async () => {
    for (let at = 0; at < 60; at += 1) {
      const id = `bulk-${String(at).padStart(2, "0")}`;
      await seed({ id, lastMessageAt: T0 + 1000 + at }, { id: `m-${id}`, subject: "Bulk", body: "parcel lost" });
    }
    expect(await search({}, { q: "parcel" }).then((outcome) => outcome.results.length)).toBe(20);
    expect(await search({}, { q: "parcel", limit: 500 }).then((outcome) => outcome.results.length)).toBe(50);
  });

  test("a keyword hit wins a tie with a semantic-only hit, however much newer that one is", async () => {
    // Keyword's top is `order` and semantic's is `shipping`, each found by one backend at rank 1: equal fused
    // scores. The keyword hit comes first, though `shipping` is the newer thread.
    const tie = await search(
      {
        ...semantic,
        store: {
          ...store,
          query: async () => ({ count: 1, matches: [{ id: "m-ship", score: 0.5 }] }),
        },
      },
      { q: "ORD-40912" },
    );
    expect(threads(tie)).toEqual(["order", "shipping"]);
  });

  test("lastMessageAt orders threads the ranking cannot tell apart, newest first", async () => {
    // The LIKE scan has no score, so its list is already newest first; the result keeps that order.
    expect(threads(await search({}, { q: "shipped", mode: "keyword" }))).toEqual(["shipping", "order"]);
  });
});
