// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { VectorIndexConfig } from "../config/config";
import { VectorDimensionMismatchError, VectorMetadataTooLargeError, VectorTopKExceededError } from "../error/errors";
import { assertFilterSize, type CompiledFilter } from "./filter";
import {
  byteLength,
  DEFAULT_TOPK,
  MAX_METADATA_BYTES,
  MAX_NAME_BYTES,
  MAX_TOPK_WITH_PAYLOAD,
  MAX_TOPK_WITHOUT_PAYLOAD,
  MAX_UPSERT_BATCH,
  MAX_VECTOR_ID_BYTES,
} from "./limits";

/**
 * The Vectorize calls, over the `env.VECTORIZE` binding (bindings-first — CLAUDE.md §Cloudflare access).
 *
 * The binding is typed structurally as {@link VectorStore} rather than depending on the exact `VectorizeIndex`
 * shape, so a test injects a fake and the code never reaches for a global. That is not a testing nicety here:
 * Cloudflare ships **no local emulation for Vectorize**, so injection is the only way to unit-test any of this
 * at all. The seam is always the first parameter.
 *
 * Every ceiling Vectorize publishes is checked before the call, not after. Vectorize's own rejections arrive
 * as opaque errors that name neither the limit nor the offending vector, and the worst of them — a topK above
 * the ceiling for the requested payload — is the kind of mistake that ships.
 */

/** A vector on its way into the index: an id, its components, and the metadata a filter can match on. */
export interface VectorUpsert {
  /** The vector's id — at most 64 bytes, and the join key back to the document row. */
  id: string;
  /** The embedding, exactly `dimensions` long. */
  values: number[];
  /** The metadata this vector carries. Under 10 KiB; long text belongs in the document table. */
  metadata?: Record<string, unknown>;
  /** The namespace this vector belongs to, when the index is partitioned. */
  namespace?: string;
}

/** Options a similarity query accepts. */
export interface VectorQueryOptions {
  /**
   * How many matches to return. Falls back to {@link DEFAULT_TOPK} — a caller that wants the capability's
   * configured `defaultTopK` passes it, because this seam takes one index's config, not the project's.
   */
  topK?: number;
  /** Restrict the search to one namespace. */
  namespace?: string;
  /** A compiled metadata filter — build it with `vectorFilter`, never by hand. */
  filter?: CompiledFilter;
  /** Return each match's components. Costs payload, and lowers the topK ceiling to 50. */
  returnValues?: boolean;
  /** Return each match's metadata. Costs payload, and lowers the topK ceiling to 50. */
  returnMetadata?: boolean;
}

/**
 * The subset of the Vectorize binding this module uses. Responses are `unknown`: their shape is the runtime's,
 * so it is validated here rather than trusted.
 */
export interface VectorStore {
  /** Insert or replace vectors. Asynchronous — the returned mutation id is an acknowledgement, not a write. */
  upsert(vectors: VectorUpsert[]): Promise<unknown>;
  /** Find the nearest neighbours of a vector. */
  query(vector: number[], options?: Record<string, unknown>): Promise<unknown>;
  /** Delete vectors by id. Optional here so a fake may omit it; guarded before use. */
  deleteByIds?: (ids: string[]) => Promise<unknown>;
}

const MutationAck = z
  .object({ mutationId: z.string().describe("Vectorize's id for the enqueued mutation.") })
  .describe("The acknowledgement Vectorize returns for an enqueued write — the write itself lands later.");

const QueryMatch = z
  .object({
    id: z.string().describe("The matched vector's id."),
    score: z.number().describe("The similarity score, as scored by the index's metric."),
    values: z.array(z.number()).optional().describe("The matched vector's components, when values were requested."),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The matched vector's metadata, when metadata was requested."),
    namespace: z.string().nullish().describe("The namespace the match belongs to, when the index is partitioned."),
  })
  .describe("One nearest-neighbour match Vectorize returned.");

const QueryResponse = z
  .object({
    count: z.number().describe("How many matches came back."),
    matches: z.array(QueryMatch).describe("The matches, nearest first."),
  })
  .describe("The shape of a Vectorize query response.");

/** A query's result: the matches, nearest first. */
export type VectorQueryResult = z.infer<typeof QueryResponse>;

/** A namespace is a Vectorize identifier, so it carries the same 64-byte ceiling as an index name. */
function assertNamespace(namespace: string | undefined): void {
  if (namespace === undefined) return;
  if (namespace.length === 0 || byteLength(namespace) > MAX_NAME_BYTES) {
    throw new ValidationError({
      message: "That namespace is not usable.",
      action: `A namespace is between 1 and ${MAX_NAME_BYTES} bytes.`,
      detail: `namespace '${namespace}' is ${byteLength(namespace)} bytes`,
    });
  }
}

/** The vector must be exactly as long as the index was created for. Dimensions cannot be changed later. */
function assertDimensions(index: VectorIndexConfig, values: number[], context: string): void {
  if (values.length !== index.dimensions) {
    throw new VectorDimensionMismatchError({
      detail: `${context}: got ${values.length} components, index expects ${index.dimensions} (model ${index.model})`,
    });
  }
}

/**
 * Validate and upsert a batch. Returns Vectorize's mutation id — an acknowledgement, not a completed write:
 * Vectorize applies writes asynchronously, so nothing here may be read back immediately.
 */
export async function upsertVectors(
  store: VectorStore,
  index: VectorIndexConfig,
  vectors: VectorUpsert[],
): Promise<string> {
  if (vectors.length === 0) {
    throw new ValidationError({
      message: "Nothing to write.",
      action: "Pass at least one vector.",
      detail: "upsertVectors received an empty batch",
    });
  }
  if (vectors.length > MAX_UPSERT_BATCH) {
    throw new ValidationError({
      message: "Too many vectors in one write.",
      action: `Write at most ${MAX_UPSERT_BATCH} vectors per call and repeat.`,
      detail: `upsertVectors received ${vectors.length} vectors; the Workers binding accepts ${MAX_UPSERT_BATCH}`,
    });
  }

  for (const vector of vectors) {
    if (vector.id.length === 0 || byteLength(vector.id) > MAX_VECTOR_ID_BYTES) {
      throw new ValidationError({
        message: "That vector id is not usable.",
        action: `A vector id is between 1 and ${MAX_VECTOR_ID_BYTES} bytes.`,
        detail: `vector id '${vector.id.slice(0, 32)}…' is ${byteLength(vector.id)} bytes`,
      });
    }
    assertDimensions(index, vector.values, `vector '${vector.id}'`);
    if (vector.metadata) {
      const size = byteLength(JSON.stringify(vector.metadata));
      if (size >= MAX_METADATA_BYTES) {
        throw new VectorMetadataTooLargeError({
          detail: `vector '${vector.id}' carries ${size} bytes of metadata; the limit is ${MAX_METADATA_BYTES}`,
        });
      }
    }
    assertNamespace(vector.namespace);
  }

  const raw = await store.upsert(vectors);
  const parsed = MutationAck.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError({
      message: "The vector store returned something unexpected.",
      detail: "Vectorize upsert returned an unexpected shape",
    });
  }
  return parsed.data.mutationId;
}

/**
 * Validate and run a similarity query. `topK` is checked against the ceiling that applies to *this* query:
 * Vectorize allows 100 matches when it returns neither values nor metadata, and 50 when it returns either.
 */
export async function queryVectors(
  store: VectorStore,
  index: VectorIndexConfig,
  vector: number[],
  options: VectorQueryOptions = {},
): Promise<VectorQueryResult> {
  assertDimensions(index, vector, "query vector");
  assertNamespace(options.namespace ?? index.namespace);

  const returnsPayload = options.returnValues === true || options.returnMetadata === true;
  const ceiling = returnsPayload ? MAX_TOPK_WITH_PAYLOAD : MAX_TOPK_WITHOUT_PAYLOAD;
  const topK = options.topK ?? DEFAULT_TOPK;
  if (topK < 1) {
    throw new ValidationError({
      message: "Ask for at least one match.",
      action: "topK is a positive whole number.",
      detail: `topK was ${topK}`,
    });
  }
  if (topK > ceiling) {
    throw new VectorTopKExceededError({
      detail: `topK ${topK} exceeds ${ceiling} for a query that returns ${returnsPayload ? "values or metadata" : "neither values nor metadata"}`,
    });
  }
  if (options.filter) assertFilterSize(options.filter);

  const namespace = options.namespace ?? index.namespace;
  const raw = await store.query(vector, {
    topK,
    returnValues: options.returnValues === true,
    returnMetadata: options.returnMetadata === true,
    ...(namespace ? { namespace } : {}),
    ...(options.filter ? { filter: options.filter } : {}),
  });

  const parsed = QueryResponse.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError({
      message: "The vector store returned something unexpected.",
      detail: "Vectorize query returned an unexpected shape",
    });
  }
  return parsed.data;
}

/** Delete vectors by id. Guarded, because a fake — or an older binding — may not carry the method. */
export async function deleteVectors(store: VectorStore, ids: string[]): Promise<string> {
  if (!store.deleteByIds) {
    throw new InternalError({
      message: "This vector index cannot delete.",
      detail: "the Vectorize binding does not expose deleteByIds",
    });
  }
  const raw = await store.deleteByIds(ids);
  const parsed = MutationAck.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError({
      message: "The vector store returned something unexpected.",
      detail: "Vectorize deleteByIds returned an unexpected shape",
    });
  }
  return parsed.data.mutationId;
}
