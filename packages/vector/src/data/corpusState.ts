// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { VECTOR_DOCUMENTS_TABLE, type VectorDatabase } from "./tables";

/**
 * What the corpus says about one index, for the control-plane read (#730). Counts only, by construction.
 *
 * **The model breakdown is the point.** `markEmbedded` stamps every row with the model it was embedded under,
 * so a model changed in config and never reprocessed leaves rows from two embedding spaces in one index, and
 * queries compare across them with nothing erroring. A timestamp cannot say that. A count of rows on another
 * model says it exactly, and names how much work `pithy vector reprocess` has to do. The three buckets are the
 * ones reprocess acts on: a row on any other model is stale, and a row with no model was written and never
 * reached the index.
 *
 * **Namespaces are a number and never a list.** A namespace partitions one index, and for many adopters it is
 * a tenant or organization id, so naming them would enumerate those ids to every holder of the read scope. The
 * default namespace, a null column, is not counted as one.
 *
 * Each read is one statement answered by an index the migration already built: `(indexName, model)` for the
 * breakdown, `(indexName, namespace, id)` for the namespaces. Structural, like `DocumentStore`, so the
 * route and the health summary are tested with a fake and this is tested against real D1.
 */

/** How one index's documents split by the model they were embedded under. */
export interface EmbeddingBreakdown {
  /** Rows embedded under the model config declares for the index. */
  declaredModel: number;
  /** Rows embedded under any other model — what `pithy vector reprocess` re-embeds. */
  otherModel: number;
  /** Rows written and never embedded: durable, not searchable. */
  unembedded: number;
}

/** The corpus reads the control plane makes. Structural, so a test injects a fake. */
export interface CorpusState {
  /** How the index's documents split by model, against the model config declares. */
  embedding(indexName: string, declaredModel: string): Promise<EmbeddingBreakdown>;
  /** How many distinct non-default namespaces the index's documents use. A count; never a name. */
  namespaces(indexName: string): Promise<number>;
}

/** The Kysely-backed {@link CorpusState} over the app database's `DB` binding. */
export function vectorCorpusState(db: VectorDatabase): CorpusState {
  return {
    async embedding(indexName, declaredModel) {
      const row = await db
        .selectFrom(VECTOR_DOCUMENTS_TABLE)
        .select((eb) => [
          eb.fn.countAll<number>().filterWhere("model", "=", declaredModel).as("declaredModel"),
          eb.fn.countAll<number>().filterWhere("model", "is", null).as("unembedded"),
          eb.fn.countAll<number>().as("total"),
        ])
        .where("indexName", "=", indexName)
        .executeTakeFirstOrThrow();
      const declared = Number(row.declaredModel);
      const unembedded = Number(row.unembedded);
      return { declaredModel: declared, otherModel: Number(row.total) - declared - unembedded, unembedded };
    },

    async namespaces(indexName) {
      const row = await db
        .selectFrom(VECTOR_DOCUMENTS_TABLE)
        .select((eb) => eb.fn.count<number>("namespace").distinct().as("namespaces"))
        .where("indexName", "=", indexName)
        .executeTakeFirstOrThrow();
      return Number(row.namespaces);
    },
  };
}
