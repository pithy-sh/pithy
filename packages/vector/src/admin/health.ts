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
 * What vector contributes to its manifest entry: two counts, so a management client can say *this corpus is
 * mixed* and *this index was never provisioned* from the read it already made, and call
 * `GET {basePath}/indexes` to see which (#730).
 *
 * Both are behind `vector:indexes:read`, the scope the index read already requires, so a caller without it
 * gets no value rather than a zero. `defineCapabilityHealth` checks that at assembly.
 *
 * **Drift is not a third key.** A drifted index refuses every non-admin route already, so it is not quiet; and
 * folding it into the unprovisioned count would give one number two meanings. The index read names it.
 */

/** Documents not on their index's declared model: embedded under another, or never embedded. */
export const STALE_VECTOR_DOCUMENTS = "staleVectorDocuments";

/** Declared indexes the provision record does not name. */
export const UNPROVISIONED_VECTOR_INDEXES = "unprovisionedVectorIndexes";

/**
 * Every declared index's stale rows, summed: the set `pithy vector reprocess` re-embeds by default, rows on
 * another model and rows on none. One statement per declared index, so the bound is the config's index count.
 */
export async function staleDocuments(config: VectorConfig, corpus: CorpusState): Promise<number> {
  const counts = await Promise.all(
    Object.entries(config.indexes).map(([name, index]) => corpus.embedding(name, index.model)),
  );
  return counts.reduce((sum, count) => sum + count.otherModel + count.unembedded, 0);
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
        key: STALE_VECTOR_DOCUMENTS,
        kind: "count",
        states: null,
        scope: VECTOR_INDEXES_READ_SCOPE,
        // One count per declared index over `pithyVectorDocumentsModelIdx` on `(indexName, model)`, the
        // index the migration built for exactly this read. Bounded by how many indexes config declares.
        cost: "indexed",
        // Zero is the good answer: every row is in its index's declared embedding space.
        nominal: { atMost: 0 },
        summary: `Documents embedded under a model other than the one their index declares, or never embedded. \`${commandName("vector reprocess")}\` re-embeds them.`,
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
        [STALE_VECTOR_DOCUMENTS]: await staleDocuments(config, corpus(c)),
        [UNPROVISIONED_VECTOR_INDEXES]: unprovisionedIndexes(config, record),
      };
    },
  });
}
