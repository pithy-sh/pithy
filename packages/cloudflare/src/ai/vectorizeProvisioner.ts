// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse, isNotFoundError } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** The distance metric an index scores nearest neighbours with. Fixed at creation — it cannot be changed later. */
export const VectorizeMetric = z
  .enum(["cosine", "euclidean", "dot-product"])
  .describe("The distance metric a Vectorize index scores nearest neighbours with. Fixed at index creation.");
export type VectorizeMetric = z.infer<typeof VectorizeMetric>;

/**
 * A Cloudflare-managed embedding preset. Naming one lets Cloudflare pick the dimensions and metric that
 * match the model, so an index and the model that fills it cannot drift apart.
 */
export const VectorizePreset = z
  .enum([
    "@cf/baai/bge-small-en-v1.5",
    "@cf/baai/bge-base-en-v1.5",
    "@cf/baai/bge-large-en-v1.5",
    "openai/text-embedding-ada-002",
    "cohere/embed-multilingual-v2.0",
  ])
  .describe("An embedding model preset Cloudflare maps to a fixed dimensions/metric pair at index creation.");
export type VectorizePreset = z.infer<typeof VectorizePreset>;

/** The shape of the vectors an index holds: how many components each carries, and how they are compared. */
export const VectorizeIndexConfig = z
  .object({
    dimensions: z
      .number()
      .int()
      .positive()
      .describe("The number of components in every vector the index holds. Cloudflare allows 32 to 1536."),
    metric: VectorizeMetric,
  })
  .describe("A Vectorize index's vector shape: its dimension count and the distance metric it scores with.");
export type VectorizeIndexConfig = z.output<typeof VectorizeIndexConfig>;

/** A Vectorize index's identity and shape, decoded from the create/get/list responses. */
export const VectorizeIndexInfo = z
  .object({
    name: z.string().min(1).describe("The index name — Vectorize's sole address for an index (no separate uuid id)."),
    config: VectorizeIndexConfig.describe("The dimensions and metric the index was created with."),
    description: z.string().optional().describe("The operator-supplied description, when the index carries one."),
  })
  .describe("A Cloudflare Vectorize index's identity and vector shape, as returned by the control-plane endpoints.");
export type VectorizeIndexInfo = z.output<typeof VectorizeIndexInfo>;

/** The type of a metadata property an index can filter on. Chosen per property when the metadata index is created. */
export const VectorizeMetadataIndexType = z
  .enum(["string", "number", "boolean"])
  .describe("The value type of an indexed metadata property, which decides how filters compare against it.");
export type VectorizeMetadataIndexType = z.infer<typeof VectorizeMetadataIndexType>;

/**
 * The type as the **list** endpoint reports it, normalized to the casing the **create** endpoint accepts.
 *
 * Live Cloudflare answers `metadataIndex.list` with `"String"` while `metadataIndex.create` takes `"string"`
 * (verified against the account on 2026-07-28). Normalizing on decode is not cosmetic: every consumer compares
 * a declared type against a live one — `@pithy-sh/vector`'s drift check does exactly that — and `"String" !==
 * "string"` would report every correctly-provisioned index as mismatched, then send the operator to re-embed a
 * corpus that was never wrong.
 */
const ListedMetadataIndexType = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(VectorizeMetadataIndexType)
  .describe("The value type of an indexed metadata property as the list endpoint reports it, lowercased.");

/** One indexed metadata property on a Vectorize index — the unit that makes a metadata filter possible. */
export const VectorizeMetadataIndex = z
  .object({
    propertyName: z.string().min(1).describe("The metadata property this index covers (e.g. `tenantId`)."),
    indexType: ListedMetadataIndexType,
  })
  .describe("An indexed metadata property on a Vectorize index, as returned by the metadata-index list endpoint.");
export type VectorizeMetadataIndex = z.output<typeof VectorizeMetadataIndex>;

/**
 * How a new index is shaped: either an explicit dimensions/metric pair, or a Cloudflare embedding preset
 * that resolves to one. Both are modelled because a caller that owns its embedding model wants the explicit
 * pair, while a caller using a stock Cloudflare model is better served by the preset — naming the model once
 * instead of restating its dimensions and risking a mismatch.
 */
export type VectorizeIndexSpec = { dimensions: number; metric: VectorizeMetric } | { preset: VectorizePreset };

/**
 * Whether an error means "that index is not there".
 *
 * Vectorize answers a **deleted** index with `410 Gone` (`vectorize.index.deleted`), not `404` — verified live
 * on 2026-07-28. For find-then-create provisioning the two are the same answer, and only one of them was being
 * treated that way: `findIndexByName` threw on a deleted index, so `pithy vector provision` would fail on
 * precisely the case it exists to repair — an index someone removed.
 */
function isAbsentIndexError(error: unknown): boolean {
  if (isNotFoundError(error)) return true;
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 410;
}

/** Vectorize's error code for "that metadata index is not there" — verified live on 2026-07-28. */
const METADATA_INDEX_ABSENT_CODE = 40005;

/**
 * Whether an error means "that metadata index is not there".
 *
 * A third spelling of absence, on top of the 404 and 410 {@link isAbsentIndexError} already covers.
 * Deleting a metadata index that does not exist answers **`400` with error code 40005** — verified live
 * on 2026-07-28 against `metadata index with name=tenantId does not exist`. So `deleteMetadataIndex`
 * documented itself as idempotent while throwing on the one case idempotency is for, and teardown could
 * not re-run.
 *
 * The check is deliberately narrow. A bare `status === 400` would swallow every malformed request this
 * endpoint rejects — a bad property name, a missing account — and turn an author's mistake into a silent
 * no-op. Matching the code as well keeps "absent" distinct from "wrong".
 */
function isAbsentMetadataIndexError(error: unknown): boolean {
  if (isAbsentIndexError(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const { status, errors } = error as { status?: unknown; errors?: unknown };
  if (status !== 400 || !Array.isArray(errors)) return false;
  return errors.some((entry) => (entry as { code?: unknown } | null)?.code === METADATA_INDEX_ABSENT_CODE);
}

/** Options a new index accepts beyond its name and shape. */
export interface CreateVectorizeIndexOptions {
  /** A human description stored on the index, surfaced in the Cloudflare dashboard. */
  description?: string;
}

/**
 * Account-level Vectorize control plane: **create and delete indexes, and manage their metadata indexes**.
 * `pithy vector provision` uses this to stand up a per-environment index and declare which metadata
 * properties are filterable; teardown uses it to remove them. Unlike {@link CloudflareVectorizeManager},
 * which operates *within* one already-provisioned index (insert/query/delete vectors), this manager is
 * account-scoped and addresses indexes **by name** — Vectorize indexes carry no separate uuid id.
 *
 * Every mutation here is enqueued: Vectorize applies index and metadata-index changes asynchronously, so a
 * successful call means "accepted", not "visible". Poll {@link listMetadataIndexes} or the data-plane
 * `describe()` watermarks rather than writing and immediately reading back.
 */
export class CloudflareVectorizeProvisioner extends CloudflareManager {
  getServiceType(): string {
    return "Vectorize (control plane)";
  }

  /** Prove access by listing indexes — a read, never a destructive create/delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().vectorize.indexes.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Create a Vectorize index by name with an explicit dimensions/metric pair or a Cloudflare preset. */
  async createIndex(
    name: string,
    config: VectorizeIndexSpec,
    options: CreateVectorizeIndexOptions = {},
  ): Promise<VectorizeIndexInfo> {
    const response = await cloudflareRequest(`create Vectorize index ${name}`, () =>
      this.getClient().vectorize.indexes.create({
        account_id: this.accountId,
        name,
        config,
        ...(options.description ? { description: options.description } : {}),
      }),
    );
    return decodeResponse(VectorizeIndexInfo, response, "Vectorize index create");
  }

  /** Delete a Vectorize index by name. Idempotent — a missing index is not an error, so teardown can re-run safely. */
  async deleteIndex(name: string): Promise<void> {
    await cloudflareRequest(`delete Vectorize index ${name}`, async () => {
      try {
        await this.getClient().vectorize.indexes.delete(name, { account_id: this.accountId });
      } catch (error) {
        if (isAbsentIndexError(error)) return;
        throw error;
      }
    });
  }

  /** List every Vectorize index in the account — for prefix-scan reconcile teardown and drift checks. */
  async listIndexes(): Promise<VectorizeIndexInfo[]> {
    return cloudflareRequest("list Vectorize indexes", async () => {
      const raw: unknown[] = [];
      for await (const index of this.getClient().vectorize.indexes.list({ account_id: this.accountId })) {
        raw.push(index);
      }
      return decodeResponse(z.array(VectorizeIndexInfo), raw, "Vectorize index list");
    });
  }

  /**
   * Find an index by exact name, or `null` — for idempotent provisioning. Reads the one index rather than
   * draining the account list, because a Vectorize index's name *is* its address (unlike a KV namespace,
   * whose title is not addressable). A 404 — or a 410 for a deleted one — means absent, which is an answer,
   * not a failure.
   */
  async findIndexByName(name: string): Promise<VectorizeIndexInfo | null> {
    return cloudflareRequest(`find Vectorize index ${name}`, async () => {
      try {
        const response = await this.getClient().vectorize.indexes.get(name, { account_id: this.accountId });
        return decodeResponse(VectorizeIndexInfo, response, "Vectorize index get");
      } catch (error) {
        if (isAbsentIndexError(error)) return null;
        throw error;
      }
    });
  }

  /**
   * Make a metadata property filterable. Cloudflare caps an index at 10 indexed properties, and only vectors
   * written **after** the metadata index exists are covered — so declare these before the first insert.
   * The change is enqueued asynchronously; the returned promise resolving means accepted, not live.
   */
  async createMetadataIndex(
    indexName: string,
    propertyName: string,
    indexType: VectorizeMetadataIndexType,
  ): Promise<void> {
    await cloudflareRequest(`create Vectorize metadata index ${indexName}.${propertyName}`, () =>
      this.getClient().vectorize.indexes.metadataIndex.create(indexName, {
        account_id: this.accountId,
        indexType,
        propertyName,
      }),
    );
  }

  /** List an index's indexed metadata properties — the read that proves a `createMetadataIndex` has landed. */
  async listMetadataIndexes(indexName: string): Promise<VectorizeMetadataIndex[]> {
    const response = await cloudflareRequest(`list Vectorize metadata indexes for ${indexName}`, () =>
      this.getClient().vectorize.indexes.metadataIndex.list(indexName, { account_id: this.accountId }),
    );
    return decodeResponse(
      z.array(VectorizeMetadataIndex),
      response?.metadataIndexes ?? [],
      "Vectorize metadata index list",
    );
  }

  /**
   * Stop filtering on a metadata property. Idempotent — a missing metadata index is not an error, matching
   * {@link deleteIndex} so teardown can re-run safely. Absence here is `400`/40005, not `404`, which is why
   * this uses {@link isAbsentMetadataIndexError} rather than the plain not-found check.
   */
  async deleteMetadataIndex(indexName: string, propertyName: string): Promise<void> {
    await cloudflareRequest(`delete Vectorize metadata index ${indexName}.${propertyName}`, async () => {
      try {
        await this.getClient().vectorize.indexes.metadataIndex.delete(indexName, {
          account_id: this.accountId,
          propertyName,
        });
      } catch (error) {
        if (isAbsentMetadataIndexError(error)) return;
        throw error;
      }
    });
  }
}
