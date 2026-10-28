// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import type { VectorIndexConfig } from "@pithy-sh/vector/src/config/config";
import { embedForIndex, type VectorAi } from "@pithy-sh/vector/src/embed/embed";
import { queryVectors, type VectorStore } from "@pithy-sh/vector/src/index/index";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";
import type { MessageHit } from "../store/search";

/**
 * The semantic half of a search: embed the query with the index's pinned model, ask Vectorize for the nearest
 * message ids, and resolve each to its thread in D1.
 *
 * **Ids without payload, so the ceiling is 100.** Vectorize allows 100 matches when it returns neither values
 * nor metadata, and the vectors carry no metadata worth returning anyway. A thread is then scored by its best
 * message, so a hundred messages roll up to the threads a page of results needs.
 *
 * A match whose message is gone — purged, say, before its vector was — resolves to nothing and is dropped.
 */

/**
 * How many message ids the semantic side asks for: Vectorize's ceiling for a payload-free query. Stated here
 * rather than imported, so support reaches only `vector`'s embed, index, provisioning and reprocess modules;
 * `vectorImports.test.ts` holds it to `vector`'s own constant.
 */
export const SEMANTIC_TOP_K = 100;

/** What a semantic query needs. */
export interface SemanticQueryDeps {
  /** The support tables, where each match is resolved to its thread. */
  db: SupportDatabase;
  /** The Workers AI binding. */
  ai: VectorAi;
  /** The message index's Vectorize binding. */
  store: VectorStore;
  /** The index's config. */
  index: VectorIndexConfig;
}

/** The messages nearest in meaning to `term`, best first, each with its raw similarity. */
export async function semanticHits(deps: SemanticQueryDeps, term: string): Promise<MessageHit[]> {
  const [vector] = await embedForIndex(deps.ai, deps.index, [term]);
  const result = await queryVectors(deps.store, deps.index, vector as number[], { topK: SEMANTIC_TOP_K });
  if (result.matches.length === 0) return [];

  const threadOf = new Map<string, string>();
  for (const group of chunkByBoundParameters(
    result.matches.map((match) => match.id),
    0,
  )) {
    const rows = await deps.db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .select(["id", "threadId"])
      .where("id", "in", group)
      .execute();
    for (const row of rows) threadOf.set(row.id, row.threadId);
  }

  const hits: MessageHit[] = [];
  for (const match of result.matches) {
    const threadId = threadOf.get(match.id);
    if (threadId !== undefined) hits.push({ messageId: match.id, threadId, score: match.score });
  }
  return hits;
}
