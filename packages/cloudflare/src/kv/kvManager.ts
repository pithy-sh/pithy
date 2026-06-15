import type { Key } from "cloudflare/resources/kv/namespaces/keys";
import {
  CloudflareInvalidResponseError,
  CloudflareNotConfiguredError,
  cloudflareRequest,
  isNotFoundError,
  reasonOf,
} from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/** Config for the KV manager: the shared client config plus the namespace it targets. */
export interface KVManagerConfig extends CloudflareManagerConfig {
  /** The KV namespace id (the REST API addresses namespaces by id, not binding name). */
  namespaceId: string;
}

/** Options for a single KV write. TTL is explicit (CLAUDE.md §KV). */
export interface KVPutOptions {
  /** Seconds until the key expires. Omit for no expiry. */
  expirationTtl?: number;
  /** Arbitrary metadata stored alongside the value. */
  metadata?: Record<string, unknown>;
}

/** One entry in a `batchSet` call. */
export interface KVOperation {
  /** The key to write. */
  key: string;
  /** The value to store. */
  value: string;
  /** Seconds until the key expires. */
  expirationTtl?: number;
  /** Metadata to store with the value. */
  metadata?: Record<string, unknown>;
}

/** The per-key outcome of a `batchSet`: a partial-failure report, never a thrown batch. */
export interface KVBatchResult {
  /** The key this result is for. */
  key: string;
  /** Whether the write succeeded. */
  success: boolean;
  /** The failure reason, present only when `success` is false. */
  error?: string;
}

/** A KV value together with its metadata, as returned by `getWithMetadata`. */
export interface KVValueWithMetadata<M = unknown> {
  /** The stored value, or null if the key is absent. */
  value: string | null;
  /** The stored metadata, or null if absent. */
  metadata: M | null;
}

/**
 * Out-of-Worker KV access over the REST API: namespace management and key reads/writes from a
 * CLI/CI/provisioning context. Inside a Worker you use the `KVNamespace` binding directly — this
 * manager is the REST counterpart, addressed by namespace id.
 */
export class CloudflareKVManager extends CloudflareManager {
  private readonly namespaceId: string;

  constructor(config: KVManagerConfig) {
    super(config);
    if (!config.namespaceId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing namespaceId for KV REST access." });
    }
    this.namespaceId = config.namespaceId;
  }

  /** Read a key's value as text. Returns null when the key is absent (the API 404s a missing key). */
  async get(key: string): Promise<string | null> {
    return cloudflareRequest(`KV get for key '${key}'`, async () => {
      try {
        const response = await this.getClient().kv.namespaces.values.get(this.namespaceId, key, {
          account_id: this.accountId,
        });
        return (response as unknown as string | null) ?? null;
      } catch (error) {
        // The REST API (and SDK) signal a missing key with a 404 throw, not a null resolve.
        if (isNotFoundError(error)) return null;
        throw error;
      }
    });
  }

  /** Read a key and `JSON.parse` it. Returns null when absent; throws on malformed JSON. */
  async getJson<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new CloudflareInvalidResponseError({
        message: `KV value for key '${key}' is not valid JSON.`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Write a value, with optional TTL and metadata. */
  async set(key: string, value: string, options?: KVPutOptions): Promise<void> {
    await cloudflareRequest(`KV set for key '${key}'`, async () => {
      await this.getClient().kv.namespaces.values.update(this.namespaceId, key, {
        account_id: this.accountId,
        value,
        ...(options?.expirationTtl !== undefined ? { expiration_ttl: options.expirationTtl } : {}),
        ...(options?.metadata !== undefined ? { metadata: JSON.stringify(options.metadata) } : {}),
      });
    });
  }

  /** Delete a key. */
  async delete(key: string): Promise<void> {
    await cloudflareRequest(`KV delete for key '${key}'`, async () => {
      await this.getClient().kv.namespaces.values.delete(this.namespaceId, key, { account_id: this.accountId });
    });
  }

  /** List keys in the namespace, optionally filtered by prefix and bounded by limit. */
  async listKeys(prefix?: string, limit?: number): Promise<Key[]> {
    return cloudflareRequest("KV list keys", async () => {
      const response = await this.getClient().kv.namespaces.keys.list(this.namespaceId, {
        account_id: this.accountId,
        ...(prefix !== undefined ? { prefix } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return response.result;
    });
  }

  /** Read a key's value and metadata together. Both are null when absent. */
  async getWithMetadata<M = unknown>(key: string): Promise<KVValueWithMetadata<M>> {
    return cloudflareRequest(`KV getWithMetadata for key '${key}'`, async () => {
      const client = this.getClient();
      const [rawValue, metadata] = await Promise.all([
        // A missing key 404s on both the value and metadata reads; treat that as absent, not an error.
        client.kv.namespaces.values
          .get(this.namespaceId, key, { account_id: this.accountId })
          .catch((error: unknown) => {
            if (isNotFoundError(error)) return null;
            throw error;
          }),
        client.kv.namespaces.metadata.get(this.namespaceId, key, { account_id: this.accountId }).catch(() => null),
      ]);
      return {
        value: (rawValue as unknown as string | null) ?? null,
        metadata: (metadata as M | null) ?? null,
      };
    });
  }

  /**
   * Write many keys, collecting a per-key result instead of failing the whole batch on the first
   * error — the caller decides what to do with partial failure.
   */
  async batchSet(operations: KVOperation[]): Promise<KVBatchResult[]> {
    const results: KVBatchResult[] = [];
    for (const operation of operations) {
      try {
        await this.set(operation.key, operation.value, {
          expirationTtl: operation.expirationTtl,
          metadata: operation.metadata,
        });
        results.push({ key: operation.key, success: true });
      } catch (error) {
        results.push({ key: operation.key, success: false, error: reasonOf(error) });
      }
    }
    return results;
  }

  /** The namespace this manager targets and the account it lives in. */
  getKVInfo(): { namespaceId: string; accountId: string } {
    return { namespaceId: this.namespaceId, accountId: this.accountId };
  }

  getServiceType(): string {
    return "KV Storage";
  }

  /** Prove access by reading the namespace record. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().kv.namespaces.get(this.namespaceId, { account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }
}
