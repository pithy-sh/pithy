// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { VectorStore } from "@pithy-sh/vector/src/index/index";
import { beforeEach, describe, expect, test } from "vitest";
import { SupportConfig } from "../config/config";
import { supportDatabase } from "../data/tables";
import { freshSupportSchema, seedMessage, seedThread } from "../test-utils/seed";
import { fakeAi } from "../test-utils/semantic";
import { supportMessageIndex } from "./messageIndex";
import { SEMANTIC_TOP_K, semanticHits } from "./query";

/**
 * The semantic half of a search against real D1, with a store that answers fixed matches so the order and the
 * scores under test are the store's and nothing else's.
 */

const db = supportDatabase(env.DB);
const T0 = 1_700_000_000_000;
const index = (() => {
  const found = supportMessageIndex(SupportConfig.parse({ search: { semantic: true } }).search);
  if (!found) throw new Error("semantic: true must yield an index");
  return found;
})();

/** A store that answers `matches` to every query and keeps each query's options. */
function answering(matches: { id: string; score: number }[]): VectorStore & { queries: Record<string, unknown>[] } {
  const queries: Record<string, unknown>[] = [];
  return {
    queries,
    async upsert() {
      return { mutationId: "m-0" };
    },
    async query(_vector, options = {}) {
      queries.push(options);
      return { count: matches.length, matches };
    },
    async deleteByIds() {
      return { mutationId: "m-0" };
    },
  };
}

beforeEach(async () => {
  await freshSupportSchema(env.DB);
  await seedThread(db, { id: "t1", lastMessageAt: T0 });
  await seedThread(db, { id: "t2", lastMessageAt: T0 + 1 });
  await seedMessage(db, { id: "m1", threadId: "t1", subject: "Upload stops", body: "It dies halfway." });
  await seedMessage(db, { id: "m2", threadId: "t2", subject: "Refund", body: "I was charged twice." });
  await seedMessage(db, { id: "m3", threadId: "t1", subject: "Still failing", body: "Same upload problem." });
});

describe("semanticHits", () => {
  test("keeps the store's order and raw scores, not the order D1 returns the rows in", async () => {
    const store = answering([
      { id: "m3", score: 0.91 },
      { id: "m1", score: 0.62 },
      { id: "m2", score: 0.18 },
    ]);
    expect(await semanticHits({ db, ai: fakeAi(index.dimensions), store, index }, "upload broken")).toEqual([
      { messageId: "m3", threadId: "t1", score: 0.91 },
      { messageId: "m1", threadId: "t1", score: 0.62 },
      { messageId: "m2", threadId: "t2", score: 0.18 },
    ]);
  });

  test("drops a match whose message is gone, and keeps the ones around it", async () => {
    const store = answering([
      { id: "m2", score: 0.8 },
      { id: "m-purged", score: 0.7 },
      { id: "m1", score: 0.4 },
    ]);
    expect(await semanticHits({ db, ai: fakeAi(index.dimensions), store, index }, "refund")).toEqual([
      { messageId: "m2", threadId: "t2", score: 0.8 },
      { messageId: "m1", threadId: "t1", score: 0.4 },
    ]);
  });

  test("asks for the payload-free ceiling of matches, with no values and no metadata", async () => {
    const store = answering([]);
    await semanticHits({ db, ai: fakeAi(index.dimensions), store, index }, "anything");
    expect(SEMANTIC_TOP_K).toBe(100);
    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]).toMatchObject({ topK: 100, returnValues: false, returnMetadata: false });
  });

  test("embeds the term with the index's pinned model", async () => {
    const ai = fakeAi(index.dimensions);
    await semanticHits({ db, ai, store: answering([]), index }, "upload broken");
    expect(ai.calls).toEqual([{ model: "@cf/baai/bge-m3", texts: ["upload broken"] }]);
  });

  test("no matches is no hits", async () => {
    expect(await semanticHits({ db, ai: fakeAi(index.dimensions), store: answering([]), index }, "x")).toEqual([]);
  });
});
