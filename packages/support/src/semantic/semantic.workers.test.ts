// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { ReprocessStep } from "@pithy-sh/vector/src/workflows/reprocess";
import { reprocessIndex } from "@pithy-sh/vector/src/workflows/reprocess";
import { beforeEach, describe, expect, test } from "vitest";
import { SupportConfig } from "../config/config";
import { SupportEmbedding } from "../data/embedding";
import { SUPPORT_EMBEDDINGS_TABLE, supportDatabase } from "../data/tables";
import { freshSupportSchema, seedMessage, seedThread } from "../test-utils/seed";
import { fakeAi, fakeVectorStore } from "../test-utils/semantic";
import { supportMessageDocuments } from "./documents";
import { embedMessage } from "./embed";
import { SUPPORT_MESSAGES_INDEX, supportMessageIndex } from "./messageIndex";

/**
 * The message index against real D1: one message embedded on arrival, and the corpus re-embedded through
 * `@pithy-sh/vector`'s own reprocess orchestration over support's `DocumentStore`.
 */

const db = supportDatabase(env.DB);
const T0 = 1_700_000_000_000;
const NOW = new Date(T0 + 1000);
const index = (() => {
  const found = supportMessageIndex(SupportConfig.parse({ search: { semantic: true } }).search);
  if (!found) throw new Error("semantic: true must yield an index");
  return found;
})();

/** A step runner that just runs, the way a fresh Workflow instance does. */
const steps: ReprocessStep = { do: (_name, callback) => callback() };

async function stamps(): Promise<Record<string, string>> {
  const rows = await db.selectFrom(SUPPORT_EMBEDDINGS_TABLE).selectAll().execute();
  return Object.fromEntries(rows.map((row) => [row.messageId, SupportEmbedding.parse(row).model]));
}

beforeEach(async () => {
  await freshSupportSchema(env.DB);
  await seedThread(db, { id: "t1", lastMessageAt: T0 });
  await seedMessage(db, {
    id: "m1",
    threadId: "t1",
    subject: "Order ORD-40912 never arrived",
    body: "My address is 12 Private Lane and I paid with my card.",
  });
});

describe("embedMessage", () => {
  test("writes one vector under the message id, then stamps the model", async () => {
    const ai = fakeAi(index.dimensions);
    const store = fakeVectorStore();
    expect(await embedMessage({ db, ai, store, index, now: () => NOW }, "m1")).toBe(true);
    expect(store.vectors.has("m1")).toBe(true);
    expect(ai.calls[0]?.model).toBe("@cf/baai/bge-m3");
    expect(await stamps()).toEqual({ m1: "@cf/baai/bge-m3" });
  });

  test("vectors carry ids only — no subject, body or address reaches Vectorize metadata", async () => {
    const store = fakeVectorStore();
    await embedMessage({ db, ai: fakeAi(index.dimensions), store, index, now: () => NOW }, "m1");
    const written = store.upserts.flat();
    expect(written).toHaveLength(1);
    for (const vector of written) {
      expect(Object.keys(vector).sort()).toEqual(["id", "values"]);
      const serialized = JSON.stringify({ ...vector, values: undefined });
      for (const secret of ["ORD-40912", "Private Lane", "ada@example.com", "card"]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  test("a message that is gone embeds nothing and says so", async () => {
    const store = fakeVectorStore();
    expect(await embedMessage({ db, ai: fakeAi(index.dimensions), store, index, now: () => NOW }, "nope")).toBe(false);
    expect(store.upserts).toEqual([]);
  });

  test("a model that cannot be reached throws before anything is stamped", async () => {
    const ai = fakeAi(index.dimensions);
    ai.fail = true;
    await expect(embedMessage({ db, ai, store: fakeVectorStore(), index, now: () => NOW }, "m1")).rejects.toThrow();
    expect(await stamps()).toEqual({});
  });
});

describe("supportMessageDocuments", () => {
  beforeEach(async () => {
    await seedMessage(db, { id: "m2", threadId: "t1", subject: "Re", body: "Still waiting", receivedAt: T0 + 1 });
    await seedMessage(db, {
      id: "m3",
      threadId: "t1",
      subject: "Re",
      body: "Our answer",
      receivedAt: T0 + 2,
      direction: "outbound",
    });
  });

  test("pages inbound messages only, in id order, with their stamp as the model", async () => {
    const documents = supportMessageDocuments(db);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1"], "old-model", NOW);
    const page = await documents.page({ indexName: SUPPORT_MESSAGES_INDEX, after: null, limit: 10 });
    expect(page.map((document) => [document.id, document.model])).toEqual([
      ["m1", "old-model"],
      ["m2", null],
    ]);
    expect(page[0]?.content).toContain("ORD-40912");
    expect(page[0]?.metadata).toEqual({});
  });

  test("the stale scan reads what was never stamped and what another model stamped", async () => {
    const documents = supportMessageDocuments(db);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1"], index.model, NOW);
    const stale = await documents.page({
      indexName: SUPPORT_MESSAGES_INDEX,
      after: null,
      limit: 10,
      staleModel: index.model,
    });
    expect(stale.map((document) => document.id)).toEqual(["m2"]);
  });

  test("a stamp is replaced, not duplicated, and another index's name reads nothing", async () => {
    const documents = supportMessageDocuments(db);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1", "m2"], "a", NOW);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1"], "b", NOW);
    expect(await stamps()).toEqual({ m1: "b", m2: "a" });
    expect(await documents.page({ indexName: "docs", after: null, limit: 10 })).toEqual([]);
    expect((await documents.get(SUPPORT_MESSAGES_INDEX, "m2"))?.model).toBe("a");
    expect((await documents.byIds(SUPPORT_MESSAGES_INDEX, ["m1", "m3"])).map((document) => document.id)).toEqual([
      "m1",
    ]);
    expect(await documents.remove(SUPPORT_MESSAGES_INDEX, "m1")).toBe(true);
    expect(await stamps()).toEqual({ m2: "a" });
  });

  test("put refuses: the corpus is support's messages, written by support", async () => {
    await expect(supportMessageDocuments(db).put([])).rejects.toThrow(/cannot be written/);
  });

  test("a large batch of stamps fits under D1's bound-parameter cap", async () => {
    const ids = Array.from({ length: 250 }, (_, at) => `bulk-${String(at).padStart(3, "0")}`);
    for (const id of ids) await seedMessage(db, { id, threadId: "t1", subject: "Bulk", body: id });
    await supportMessageDocuments(db).markEmbedded(SUPPORT_MESSAGES_INDEX, ids, "a", NOW);
    expect(Object.keys(await stamps())).toHaveLength(250);
  });

  test("a message deleted while its vector was being written keeps neither the vector nor a stamp", async () => {
    const store = fakeVectorStore();
    const upsert = store.upsert.bind(store);
    // A purge landing between the read of the message and the upsert of its vector.
    store.upsert = async (batch) => {
      await env.DB.prepare("DELETE FROM pithy_support_messages WHERE id = 'm1'").run();
      return upsert(batch);
    };
    expect(await embedMessage({ db, ai: fakeAi(index.dimensions), store, index, now: () => NOW }, "m1")).toBe(false);
    expect(store.vectors.has("m1")).toBe(false);
    expect(await stamps()).toEqual({});
  });

  test("a re-embed stamps only messages that still exist, and deletes the vector of one that does not", async () => {
    const store = fakeVectorStore();
    await store.upsert([{ id: "gone", values: [1] }]);
    await supportMessageDocuments(db, { store }).markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1", "gone"], "a", NOW);
    expect(await stamps()).toEqual({ m1: "a" });
    expect(store.vectors.has("gone")).toBe(false);
  });
});

describe("re-embedding through vector's reprocess orchestration", () => {
  beforeEach(async () => {
    await seedMessage(db, { id: "m2", threadId: "t1", subject: "Re", body: "Still waiting", receivedAt: T0 + 1 });
  });

  test("the default pass re-embeds exactly what drifted, and stamps the configured model", async () => {
    const documents = supportMessageDocuments(db);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1"], index.model, NOW);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m2"], "@cf/old", NOW);
    const store = fakeVectorStore();
    const report = await reprocessIndex(
      {
        documents,
        store,
        ai: fakeAi(index.dimensions),
        index,
        indexName: SUPPORT_MESSAGES_INDEX,
        now: () => NOW,
      },
      steps,
    );
    expect(report.reembedded).toBe(1);
    expect([...store.vectors.keys()]).toEqual(["m2"]);
    expect(await stamps()).toEqual({ m1: index.model, m2: index.model });
  });

  test("--all re-embeds every message, and still writes ids and no text", async () => {
    const store = fakeVectorStore();
    const documents = supportMessageDocuments(db);
    await documents.markEmbedded(SUPPORT_MESSAGES_INDEX, ["m1", "m2"], index.model, NOW);
    const report = await reprocessIndex(
      { documents, store, ai: fakeAi(index.dimensions), index, indexName: SUPPORT_MESSAGES_INDEX, now: () => NOW },
      steps,
      { all: true },
    );
    expect(report.reembedded).toBe(2);
    for (const vector of store.upserts.flat()) {
      expect(vector.metadata ?? {}).toEqual({});
      expect(JSON.stringify({ ...vector, values: undefined })).not.toContain("ORD-40912");
    }
  });
});
