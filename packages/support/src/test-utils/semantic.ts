// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { VectorAi } from "@pithy-sh/vector/src/embed/embed";
import type { VectorStore, VectorUpsert } from "@pithy-sh/vector/src/index/index";

/**
 * Stand-ins for Workers AI and Vectorize, for tests only. Cloudflare ships no local emulation of either.
 *
 * **The embedder is not random, and that is the point.** It maps words to concepts through a small synonym table
 * and hashes each concept onto a component, so cosine similarity behaves the way a real model's does for the
 * cases the tests state: a paraphrase that shares no word with a message still lands near it, and an order
 * number is just another token. The store scores by cosine and returns ids and scores, as Vectorize does with no
 * payload requested.
 */

/** Words that mean the same thing to the fake model. Everything else is its own concept. */
const CONCEPTS: Record<string, string> = {
  upload: "upload",
  uploads: "upload",
  uploading: "upload",
  file: "upload",
  files: "upload",
  dying: "interrupted",
  dies: "interrupted",
  died: "interrupted",
  timeout: "interrupted",
  times: "interrupted",
  timed: "interrupted",
  halfway: "interrupted",
  out: "interrupted",
  refund: "money",
  charged: "money",
  money: "money",
};

function concept(word: string): string {
  return CONCEPTS[word] ?? word;
}

function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

/** Embed one text the fake way: concept counts, hashed onto components, unit length. */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [];
  for (const word of words) {
    const at = hash(concept(word)) % dimensions;
    vector[at] = (vector[at] ?? 0) + 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((component) => component / length);
}

/** A fake `AI` binding: records every call and answers the shape a text-embedding model does. */
export function fakeAi(dimensions: number): VectorAi & { calls: { model: string; texts: string[] }[]; fail: boolean } {
  const ai = {
    calls: [] as { model: string; texts: string[] }[],
    fail: false,
    async run(model: string, input: Record<string, unknown>) {
      const texts = input.text as string[];
      ai.calls.push({ model, texts });
      if (ai.fail) throw new Error("Workers AI is unavailable");
      return { shape: [texts.length, dimensions], data: texts.map((text) => fakeEmbedding(text, dimensions)) };
    },
  };
  return ai;
}

/** A fake Vectorize binding: an in-memory map, scored by cosine, with every upsert kept for inspection. */
export function fakeVectorStore(): VectorStore & {
  vectors: Map<string, number[]>;
  upserts: VectorUpsert[][];
  queries: Record<string, unknown>[];
} {
  const vectors = new Map<string, number[]>();
  const upserts: VectorUpsert[][] = [];
  const queries: Record<string, unknown>[] = [];
  let mutation = 0;
  return {
    vectors,
    upserts,
    queries,
    async upsert(batch) {
      upserts.push(batch);
      for (const vector of batch) vectors.set(vector.id, vector.values);
      mutation += 1;
      return { mutationId: `m-${mutation}` };
    },
    async query(vector, options = {}) {
      queries.push(options);
      const topK = Number(options.topK ?? 10);
      const matches = [...vectors.entries()]
        .map(([id, values]) => ({ id, score: values.reduce((sum, value, at) => sum + value * (vector[at] ?? 0), 0) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { count: matches.length, matches };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      mutation += 1;
      return { mutationId: `m-${mutation}` };
    },
  };
}
