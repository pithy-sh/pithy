// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type {
  IndexDeleteByIDsResponse,
  IndexGetByIDsResponse,
  IndexInfoResponse,
  IndexInsertResponse,
  IndexQueryResponse,
  IndexUpsertResponse,
} from "cloudflare/resources/vectorize/indexes/indexes";
import { CloudflareNotConfiguredError, cloudflareRequest } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/** Config for the Vectorize manager: the shared client config plus the index it targets. */
export interface VectorizeManagerConfig extends CloudflareManagerConfig {
  /** The Vectorize index name (the REST API addresses indexes by name, not binding). */
  indexName: string;
}

/** A vector to insert or upsert: an id, its float values, and optional metadata/namespace. */
export interface VectorizeVector {
  /** The unique identifier for the vector. */
  id: string;
  /** The vector's float components. */
  values: number[];
  /** Arbitrary metadata stored alongside the vector. */
  metadata?: Record<string, unknown>;
  /** An optional namespace partitioning the index. */
  namespace?: string;
}

/** Options narrowing a nearest-neighbour query. */
export interface VectorizeQueryOptions {
  /** The number of nearest neighbours to return. */
  topK?: number;
  /** Whether to return the matched vectors' values. */
  returnValues?: boolean;
  /** Whether to return no, indexed, or all metadata for matches. */
  returnMetadata?: "none" | "indexed" | "all";
  /** A metadata filter expression limiting results. */
  filter?: unknown;
}

/**
 * Out-of-Worker Vectorize access over the REST API: insert/upsert vectors, query nearest
 * neighbours, fetch and delete by id, and describe the index from a CLI/CI/provisioning context.
 * Inside a Worker you use the `Vectorize` binding directly — this manager is the REST counterpart,
 * addressed by index name.
 */
export class CloudflareVectorizeManager extends CloudflareManager {
  private readonly indexName: string;

  constructor(config: VectorizeManagerConfig) {
    super(config);
    if (!config.indexName) {
      throw new CloudflareNotConfiguredError({ detail: "Missing indexName for Vectorize REST access." });
    }
    this.indexName = config.indexName;
  }

  /** Serialize vectors as an NDJSON file, the body shape the REST insert/upsert endpoints expect. */
  private vectorsToNdjsonFile(vectors: VectorizeVector[]): File {
    const ndjson = vectors.map((vector) => JSON.stringify(vector)).join("\n");
    return new File([ndjson], "vectors.ndjson", { type: "application/x-ndjson" });
  }

  /** Insert vectors. Returns the async-mutation id for the enqueued change. */
  async insert(vectors: VectorizeVector[]): Promise<IndexInsertResponse | null> {
    return cloudflareRequest("Vectorize insert", () =>
      this.getClient().vectorize.indexes.insert(this.indexName, {
        account_id: this.accountId,
        body: this.vectorsToNdjsonFile(vectors),
      }),
    );
  }

  /** Upsert vectors, overwriting any with matching ids. Returns the async-mutation id. */
  async upsert(vectors: VectorizeVector[]): Promise<IndexUpsertResponse | null> {
    return cloudflareRequest("Vectorize upsert", () =>
      this.getClient().vectorize.indexes.upsert(this.indexName, {
        account_id: this.accountId,
        body: this.vectorsToNdjsonFile(vectors),
      }),
    );
  }

  /** Query the index for the nearest neighbours of a vector. */
  async query(vector: number[], options?: VectorizeQueryOptions): Promise<IndexQueryResponse | null> {
    return cloudflareRequest("Vectorize query", () =>
      this.getClient().vectorize.indexes.query(this.indexName, {
        account_id: this.accountId,
        vector,
        ...(options?.topK !== undefined ? { topK: options.topK } : {}),
        ...(options?.returnValues !== undefined ? { returnValues: options.returnValues } : {}),
        ...(options?.returnMetadata !== undefined ? { returnMetadata: options.returnMetadata } : {}),
        ...(options?.filter !== undefined ? { filter: options.filter } : {}),
      }),
    );
  }

  /**
   * Query by an existing vector's id: fetch its values, then run a nearest-neighbour query with
   * them. Returns an empty result when the id is absent or has no values.
   */
  async queryById(vectorId: string, options?: VectorizeQueryOptions): Promise<IndexQueryResponse | null> {
    const vectors = await this.getByIds([vectorId]);
    const first = vectors[0];
    if (!first || !Array.isArray(first.values) || first.values.length === 0) {
      return { count: 0, matches: [] };
    }
    return this.query(first.values, options);
  }

  /** Fetch vectors by id. Returns an array (possibly empty); each element carries its values. */
  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    return cloudflareRequest("Vectorize getByIds", async () => {
      const response = (await this.getClient().vectorize.indexes.getByIDs(this.indexName, {
        account_id: this.accountId,
        ids,
      })) as IndexGetByIDsResponse;
      return (Array.isArray(response) ? response : []) as VectorizeVector[];
    });
  }

  /** Delete vectors by id. Returns the async-mutation id for the enqueued change. */
  async deleteByIds(ids: string[]): Promise<IndexDeleteByIDsResponse | null> {
    return cloudflareRequest("Vectorize deleteByIds", () =>
      this.getClient().vectorize.indexes.deleteByIDs(this.indexName, {
        account_id: this.accountId,
        ids,
      }),
    );
  }

  /** Describe the index: dimensions, vector count, and processing watermarks. */
  async describe(): Promise<IndexInfoResponse | null> {
    return cloudflareRequest("Vectorize describe", () =>
      this.getClient().vectorize.indexes.info(this.indexName, { account_id: this.accountId }),
    );
  }

  /** The index this manager targets and the account it lives in. */
  getVectorizeInfo(): { indexName: string; accountId: string } {
    return { indexName: this.indexName, accountId: this.accountId };
  }

  getServiceType(): string {
    return "Vectorize";
  }

  /** Prove access by reading the index record. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().vectorize.indexes.get(this.indexName, { account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
