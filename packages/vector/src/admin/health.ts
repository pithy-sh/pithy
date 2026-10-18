// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { type CapabilityHealth, defineCapabilityHealth } from "@pithy-sh/core/src/controlPlane/discovery/health";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import type { VectorConfig } from "../config/config";
import { type CorpusState, vectorCorpusState } from "../data/corpusState";
import { vectorDatabase } from "../data/tables";
import { VECTOR_INDEXES_READ_SCOPE } from "../http/scopes";
import { readProvisionRecord, type VectorProvisionRecord } from "../index/provisioned";

/**
 * What vector contributes to its manifest entry: a state and a count, so a management client can say *this
 * corpus is stale* and *this index was never provisioned* from the read it already made, and call
 * `GET {basePath}/indexes` to see which and how many (#730).
 *
 * **The stale key is a state, not a count.** `cost: "indexed"` means the rows a value reads are bounded by a
 * declaration, never by the adopter's data. A count of stale rows reads every entry an index holds, even through
 * `(indexName, model)`, so it would grow with the corpus on every manifest read. Whether *any* row is stale is
 * three seeks per declared index that each stop at one row. The number belongs to the index read, which a
 * person asks for once.
 *
 * Both are behind `vector:indexes:read`, the scope the index read already requires, so a caller without it
 * gets no value rather than a zero. `defineCapabilityHealth` checks that at assembly.
 *
 * **Drift is not a third key.** A drifted index refuses every non-admin route already, so it is not quiet; and
 * folding it into the unprovisioned count would give one number two meanings. The index read names it.
 */

/** Whether any document is off its index's declared model: embedded under another, or never embedded. */
export const VECTOR_CORPUS_EMBEDDING = "vectorCorpusEmbedding";

/** The values {@link VECTOR_CORPUS_EMBEDDING} takes. `current` is nominal. */
export const CORPUS_EMBEDDING_STATES = ["current", "stale"] as const;
export type CorpusEmbeddingState = (typeof CORPUS_EMBEDDING_STATES)[number];

/** Declared indexes the provision record does not name. */
export const UNPROVISIONED_VECTOR_INDEXES = "unprovisionedVectorIndexes";

/**
 * `stale` when any declared index holds a row `pithy vector reprocess` would re-embed by default: one on another
 * model or on none. One statement per declared index, each reading at most three rows, so the bound is the
 * config's index count and not the corpus.
 */
export async function corpusEmbedding(config: VectorConfig, corpus: CorpusState): Promise<CorpusEmbeddingState> {
  const stale = await Promise.all(
    Object.entries(config.indexes).map(([name, index]) => corpus.hasStale(name, index.model)),
  );
  return stale.some(Boolean) ? "stale" : "current";
}

/** How many declared indexes the record does not name. No network: the record is a var. */
export function unprovisionedIndexes(config: VectorConfig, record: VectorProvisionRecord | undefined): number {
  return Object.keys(config.indexes).filter((name) => !record?.indexes[name]).length;
}

/** The corpus over the request's `DB` binding. A missing binding throws, which the seam reports as unavailable. */
export function corpusFromContext(c: Context<PithyHonoEnv>): CorpusState {
  const db = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!db) {
    throw new InternalError({
      message: "Search is not configured.",
      action: "Bind a D1 database named DB.",
      detail: "the `DB` binding was not present on env",
    });
  }
  return vectorCorpusState(vectorDatabase(db));
}

/** Declare vector's health summary. `corpus` is the test seam; it defaults to the request's `DB`. */
export function vectorHealth(
  config: VectorConfig,
  corpus: (c: Context<PithyHonoEnv>) => CorpusState = corpusFromContext,
): CapabilityHealth {
  return defineCapabilityHealth({
    keys: [
      {
        key: VECTOR_CORPUS_EMBEDDING,
        kind: "state",
        states: [...CORPUS_EMBEDDING_STATES],
        scope: VECTOR_INDEXES_READ_SCOPE,
        // Three `LIMIT 1` seeks per declared index on `pithyVectorDocumentsModelIdx`, `(indexName, model)`.
        // Rows read: at most three per index config declares, at any corpus size. The workers suite pins the plan.
        cost: "indexed",
        // `current` is the good answer: every row is in its index's declared embedding space.
        nominal: ["current"],
        summary: `Whether any document is embedded under a model other than the one its index declares, or never embedded. \`${commandName("vector reprocess")}\` re-embeds them.`,
      },
      {
        key: UNPROVISIONED_VECTOR_INDEXES,
        kind: "count",
        states: null,
        scope: VECTOR_INDEXES_READ_SCOPE,
        // The provision record is the `VECTOR_PROVISIONED` var, already on the Worker's env. No query.
        cost: "memory",
        nominal: { atMost: 0 },
        summary: `Indexes config declares that \`${commandName("vector provision")}\` has never recorded.`,
      },
    ],
    read: async (c) => {
      // The record first: an unreadable one throws, and the seam reports the summary unavailable.
      const record = readProvisionRecord(c.env as Record<string, unknown>);
      return {
        [VECTOR_CORPUS_EMBEDDING]: await corpusEmbedding(config, corpus(c)),
        [UNPROVISIONED_VECTOR_INDEXES]: unprovisionedIndexes(config, record),
      };
    },
  });
}
