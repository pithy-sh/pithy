// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace, KVNamespacePutOptions } from "@cloudflare/workers-types";
import type { z } from "zod";
import { InternalError, messageOf, NotFoundError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { noopLogger } from "../logger/logger";

/** Cloudflare's hard limit on a KV entry's metadata, in bytes. */
export const KV_METADATA_MAX_BYTES = 1024;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Wrap a metadata schema with KV's size limit.
 *
 * WARNING: metadata travels with **every** `list` entry and is capped at
 * {@link KV_METADATA_MAX_BYTES} bytes serialized. It is for small, list-time
 * fields you want without reading each value — a status flag, a type, a
 * timestamp — never a payload. This refinement fails a value that would exceed
 * the cap, turning a late KV rejection into an early, clear validation error.
 */
export function kvMetadata<T extends z.ZodType>(schema: T) {
  return schema.refine((value) => byteLength(JSON.stringify(value)) <= KV_METADATA_MAX_BYTES, {
    message: `KV metadata exceeds ${KV_METADATA_MAX_BYTES} bytes serialized. Keep it tiny — it rides on every list entry.`,
  });
}

/** Configuration for a {@link TypedKv} store. */
export interface TypedKvConfig<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType> {
  /** Capability namespace, the fixed first key segment (e.g. `auth`, `assets`). */
  prefix: string;
  /**
   * The ordered key segments after the prefix, as a Zod object. Declared field
   * order **is** key order, and each segment is validated before a key is built
   * (e.g. `z.object({ assetType: z.enum([...]), uuid: z.uuid() })` →
   * `assets:photo:<uuid>`). Segment values must serialize to a string that does
   * not contain the separator.
   */
  key: K;
  /** Schema validating the stored value on every read and write. */
  value: V;
  /** Optional schema for metadata. Wrap with {@link kvMetadata} to bound its size. */
  metadata?: M;
  /**
   * Derive metadata from the value, making the value the single source of truth.
   *
   * When set (requires `metadata`), `put` computes metadata from the value
   * automatically — callers need not pass it — and `list` **self-heals**: any
   * entry whose metadata is missing has its value read, metadata re-derived, and
   * written back (value bytes and expiration preserved). This protects against
   * external edits — notably the Cloudflare dashboard, which drops metadata when
   * a value is hand-edited. Note: self-heal performs a read and a write per
   * missing entry during `list`.
   */
  deriveMetadata?: (value: z.output<V>) => z.input<M>;
  /** Key segment separator. Defaults to `:`. */
  separator?: string;
  /** Default TTL, in seconds, applied to every `put` unless overridden. KV's floor is 60. */
  ttlSeconds?: number;
}

/**
 * Validate a {@link TypedKvConfig} at construction — config is a boundary, so it
 * is checked, not trusted. Catches the misconfigurations the type system can't
 * (or won't, for JS callers and casts): an empty namespace, a separator that
 * collides with the prefix, a key with no segments, `deriveMetadata` without a
 * `metadata` schema to validate against, or a non-positive default TTL.
 */
export function assertValidConfig(config: TypedKvConfig<z.ZodType, z.ZodObject, z.ZodType>): void {
  // A bad TypedKv config is a capability-author mistake caught at construction — an internal
  // misconfiguration (500), never a client-facing fault. The message names the exact problem.
  if (config.prefix.length === 0) {
    throw new InternalError({ message: "TypedKv config: prefix must be a non-empty capability namespace." });
  }
  const separator = config.separator ?? ":";
  if (separator.length === 0) {
    throw new InternalError({ message: "TypedKv config: separator must be a non-empty string." });
  }
  if (config.prefix.includes(separator)) {
    throw new InternalError({
      message: `TypedKv config: prefix "${config.prefix}" must not contain the separator "${separator}".`,
    });
  }
  if (Object.keys(config.key.shape).length === 0) {
    throw new InternalError({ message: "TypedKv config: key must declare at least one segment." });
  }
  if (config.deriveMetadata !== undefined && config.metadata === undefined) {
    throw new InternalError({
      message: "TypedKv config: deriveMetadata requires a metadata schema to validate the derived value.",
    });
  }
  if (config.ttlSeconds !== undefined && config.ttlSeconds <= 0) {
    throw new InternalError({ message: "TypedKv config: ttlSeconds must be positive." });
  }
}

/** Construction options for a {@link TypedKv} store beyond its config. */
export interface TypedKvOptions {
  /**
   * The logger a store routes its observable best-effort failures through — notably the `list`
   * self-heal metadata write-back, which must not fail the surrounding list but should be seen.
   * `createBackend` passes the per-request `c.var.log`; defaults to the no-op logger.
   */
  logger?: Logger;
}

/** Per-call options for {@link TypedKv.put}. */
export interface PutOptions<M extends z.ZodType> {
  /** TTL, in seconds, for this value. Overrides the store default. KV's floor is 60. */
  ttlSeconds?: number;
  /** Metadata to store. Validated against the schema; overrides `deriveMetadata` for this write. */
  metadata?: z.input<M>;
}

/** Options for {@link TypedKv.list}. */
export interface ListOptions<K extends z.ZodObject> {
  /**
   * A leading run of key segments to scope the listing — `{ assetType: "photo" }`
   * lists `assets:photo:*`. Must be contiguous from the first segment; omit to
   * list the whole namespace.
   */
  prefix?: Partial<z.input<K>>;
  /** Maximum entries to return in this page. */
  limit?: number;
  /** Cursor from a previous page's result. */
  cursor?: string;
}

/** One entry from {@link TypedKv.list}: the key, its parsed segments, and validated metadata. */
export interface ListEntry<K extends z.ZodObject, M extends z.ZodType> {
  /** The full physical KV key. */
  name: string;
  /** The key's segments, split back out by name. */
  key: Record<keyof z.input<K>, string>;
  /** Validated metadata, or `null` when none was stored or no metadata schema is configured. */
  metadata: z.output<M> | null;
  /** Absolute expiration time (seconds since epoch), if the entry has a TTL. */
  expiration?: number;
}

/** A page of {@link TypedKv.list} results. */
export interface ListResult<K extends z.ZodObject, M extends z.ZodType> {
  /** The entries on this page. */
  keys: ListEntry<K, M>[];
  /** Cursor for the next page, or `undefined` when the listing is complete. */
  cursor?: string;
  /** Whether this page completed the listing. */
  listComplete: boolean;
}

/**
 * Typed, validated access to one Workers KV namespace.
 *
 * Keys are structured: a fixed capability `prefix` followed by ordered,
 * Zod-validated segments — so a single store models `pages:<uuid>` or
 * `assets:<assetType>:<uuid>` and `list` can scope by any leading run of those
 * segments. Values are validated on the way in and out; there is no untyped
 * `JSON.parse`. Metadata is validated too and rides along with `list`; with
 * `deriveMetadata` the value is the source of truth and `list` rebuilds metadata
 * that external edits have dropped.
 */
export class TypedKv<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType = z.ZodNever> {
  readonly #namespace: KVNamespace;
  readonly #prefix: string;
  readonly #keySchema: K;
  readonly #valueSchema: V;
  readonly #metadataSchema: M | undefined;
  readonly #deriveMetadata: ((value: z.output<V>) => z.input<M>) | undefined;
  readonly #separator: string;
  readonly #defaultTtlSeconds: number | undefined;
  readonly #segmentNames: string[];
  readonly #logger: Logger;

  constructor(namespace: KVNamespace, config: TypedKvConfig<V, K, M>, options?: TypedKvOptions) {
    assertValidConfig(config);
    this.#namespace = namespace;
    this.#prefix = config.prefix;
    this.#keySchema = config.key;
    this.#valueSchema = config.value;
    this.#metadataSchema = config.metadata;
    this.#deriveMetadata = config.deriveMetadata;
    this.#separator = config.separator ?? ":";
    this.#defaultTtlSeconds = config.ttlSeconds;
    // Declared field order is key order.
    this.#segmentNames = Object.keys(config.key.shape);
    this.#logger = options?.logger ?? noopLogger;
  }

  /** Build the full physical KV key (name) from validated segments. */
  name(key: z.input<K>): string {
    const parsed = this.#keySchema.parse(key) as Record<string, unknown>;
    const segments = this.#segmentNames.map((segment) => this.#segment(segment, parsed[segment]));
    return [this.#prefix, ...segments].join(this.#separator);
  }

  /**
   * Read and validate the value at `key`. Returns `null` on a miss. The stored
   * JSON is parsed and validated against the schema before it is returned.
   */
  async get(key: z.input<K>): Promise<z.output<V> | null> {
    const raw = await this.#namespace.get(this.name(key), "text");
    return raw === null ? null : this.#parseValue(raw);
  }

  /** Read the value at `key` together with its validated metadata. `null` on a miss. */
  async getWithMetadata(key: z.input<K>): Promise<{ value: z.output<V>; metadata: z.output<M> | null } | null> {
    const result = await this.#namespace.getWithMetadata(this.name(key), "text");
    if (result.value === null) return null;
    return { value: this.#parseValue(result.value), metadata: this.#parseMetadata(result.metadata) };
  }

  /**
   * Validate `value` (and any `metadata`) against their schemas, then store the
   * value as JSON under the namespaced key. With `deriveMetadata`, metadata is
   * computed from the value unless overridden per call. Throws (before writing)
   * on an invalid value, invalid metadata, or metadata over
   * {@link KV_METADATA_MAX_BYTES}. A per-call `ttlSeconds` overrides the default.
   */
  async put(key: z.input<K>, value: z.input<V>, options: PutOptions<M> = {}): Promise<void> {
    const validated = this.#valueSchema.parse(value) as z.output<V>;
    const putOptions: KVNamespacePutOptions = {};

    const ttlSeconds = options.ttlSeconds ?? this.#defaultTtlSeconds;
    if (ttlSeconds !== undefined) putOptions.expirationTtl = ttlSeconds;

    const metadata = this.#resolveMetadata(validated, options.metadata);
    if (metadata !== undefined) putOptions.metadata = metadata;

    await this.#namespace.put(this.name(key), JSON.stringify(validated), putOptions);
  }

  /**
   * Partially update the value at `key`: read it, merge `changes` over the
   * current fields, validate the merged result, and write it back. Returns the
   * merged value. Throws if the key does not exist — there is nothing to merge.
   *
   * Metadata stays correct: a `deriveMetadata` store recomputes it from the
   * merged value; an explicit-metadata store preserves the current metadata
   * (pass `metadata` to override). TTL resets to the store default unless
   * `ttlSeconds` is given.
   *
   * WARNING: KV has no compare-and-set, so this read-modify-write is
   * last-write-wins. Concurrent patches to the same key can lose updates — do
   * not use it where atomicity matters.
   */
  async patch(key: z.input<K>, changes: Partial<z.output<V>>, options: PutOptions<M> = {}): Promise<z.output<V>> {
    const existing = await this.getWithMetadata(key);
    if (existing === null) {
      // Patching a key that isn't there is a genuine not-found, not a server fault.
      throw new NotFoundError({ message: `Cannot patch ${this.name(key)}: no value to update.` });
    }
    const merged = this.#valueSchema.parse({ ...(existing.value as object), ...(changes as object) }) as z.output<V>;
    const putOptions: PutOptions<M> = { ...options };
    // Carry existing metadata forward only when it isn't recomputed from the value.
    if (this.#deriveMetadata === undefined && options.metadata === undefined && existing.metadata !== null) {
      putOptions.metadata = existing.metadata as z.input<M>;
    }
    await this.put(key, merged as unknown as z.input<V>, putOptions);
    return merged;
  }

  /** Delete the value at `key`. A miss is a no-op. */
  async delete(key: z.input<K>): Promise<void> {
    await this.#namespace.delete(this.name(key));
  }

  /**
   * List entries under a leading run of key segments. Each entry carries its
   * parsed key segments and validated metadata — no value reads, unless
   * `deriveMetadata` is configured and an entry's metadata is missing, in which
   * case it is rebuilt from the value and written back. Pass `options.prefix` to
   * scope (e.g. `{ assetType: "photo" }`); omit to list the whole namespace.
   */
  async list(options: ListOptions<K> = {}): Promise<ListResult<K, M>> {
    const result = await this.#namespace.list({
      prefix: this.#listPrefix(options.prefix),
      limit: options.limit,
      cursor: options.cursor,
    });
    const keys = await Promise.all(
      result.keys.map(async (entry) => ({
        name: entry.name,
        key: this.#splitKey(entry.name),
        metadata: await this.#resolveListMetadata(entry),
        expiration: entry.expiration,
      })),
    );
    return {
      keys,
      cursor: result.list_complete ? undefined : result.cursor,
      listComplete: result.list_complete,
    };
  }

  /**
   * Resolve one list entry's metadata: parse what is stored, else self-heal it
   * from the value when `deriveMetadata` is configured. A single entry with
   * corrupt or schema-incompatible metadata/value must not abort the whole
   * listing — it degrades to `null` metadata while the key is still returned.
   */
  async #resolveListMetadata(entry: {
    name: string;
    expiration?: number;
    metadata?: unknown;
  }): Promise<z.output<M> | null> {
    try {
      const stored = this.#parseMetadata(entry.metadata);
      if (stored !== null) return stored;
      const derive = this.#deriveMetadata;
      const metadataSchema = this.#metadataSchema;
      if (derive === undefined || metadataSchema === undefined) return null;
      return await this.#rebuildMetadata(entry.name, entry.expiration, derive, metadataSchema);
    } catch {
      return null;
    }
  }

  /** Resolve the metadata to store: explicit wins, else derive, else none. */
  #resolveMetadata(value: z.output<V>, explicit: unknown): z.output<M> | undefined {
    if (this.#metadataSchema === undefined) return undefined;
    let candidate: unknown;
    if (explicit !== undefined) candidate = explicit;
    else if (this.#deriveMetadata !== undefined) candidate = this.#deriveMetadata(value);
    else return undefined;
    return this.#validateMetadata(this.#metadataSchema, candidate);
  }

  /** Read the value, re-derive metadata, and write it back — preserving value bytes and expiration. */
  async #rebuildMetadata(
    name: string,
    expiration: number | undefined,
    derive: (value: z.output<V>) => z.input<M>,
    metadataSchema: M,
  ): Promise<z.output<M> | null> {
    const raw = await this.#namespace.get(name, "text");
    if (raw === null) return null;
    const derived = derive(this.#parseValue(raw));
    // If derive yields nothing, there is genuinely no metadata for this entry —
    // skip the write so we never persist empty metadata (and never throw on a
    // required schema). The entry stays metadata-less; nothing is written back.
    if (derived === null || derived === undefined) return null;
    const metadata = this.#validateMetadata(metadataSchema, derived);
    // Persist best-effort. A near-expiry `expiration` (KV requires ≥60s ahead)
    // or a transient write error must not fail the surrounding list — return the
    // healed metadata regardless; a later list retries the write if it didn't land.
    try {
      const putOptions: KVNamespacePutOptions = { metadata };
      if (expiration !== undefined) putOptions.expiration = expiration;
      await this.#namespace.put(name, raw, putOptions);
    } catch (error) {
      // Best-effort heal — the list still returns the in-memory metadata. But a persistent write
      // failure means every list re-heals the same entry, so it is observable, not ignorable: route
      // it through the logger. A near-expiry `expiration` (KV requires ≥60s ahead) is the usual cause.
      this.#logger.warn("kv metadata heal write-back failed", { key: name, detail: messageOf(error) });
    }
    return metadata;
  }

  /** Decode a stored value: JSON-parse, then validate against the value schema. */
  #parseValue(raw: string): z.output<V> {
    return this.#valueSchema.parse(JSON.parse(raw)) as z.output<V>;
  }

  /** Validate a metadata candidate against the schema and the KV size cap. */
  #validateMetadata(schema: M, candidate: unknown): z.output<M> {
    const parsed = schema.parse(candidate) as z.output<M>;
    const bytes = byteLength(JSON.stringify(parsed));
    if (bytes > KV_METADATA_MAX_BYTES) {
      throw new InternalError({
        message: `KV metadata is ${bytes} bytes; the limit is ${KV_METADATA_MAX_BYTES}. Keep metadata small.`,
      });
    }
    return parsed;
  }

  /** Stringify and guard one key segment. */
  #segment(name: string, value: unknown): string {
    const segment = String(value);
    if (segment.includes(this.#separator)) {
      // `segment` is a caller-supplied runtime value; it goes in `detail` (internal), not the
      // public `message`, so the HTTP encoder can't echo a caller's input back in a 500 body.
      throw new InternalError({
        message: `Key segment "${name}" must not contain the separator "${this.#separator}".`,
        detail: `Offending value for "${name}": ${segment}`,
      });
    }
    return segment;
  }

  /** Build the physical prefix string for a `list`, enforcing a proper, contiguous leading run. */
  #listPrefix(parts?: Partial<z.input<K>>): string {
    const trailing = `${this.#prefix}${this.#separator}`;
    if (!parts) return trailing;

    const provided = this.#keySchema.partial().parse(parts) as Record<string, unknown>;
    const present = this.#segmentNames.filter((name) => provided[name] !== undefined);
    if (present.length === 0) return trailing;

    if (present.length === this.#segmentNames.length) {
      throw new InternalError({
        message: "list prefix is a full key; use get() or getWithMetadata() for an exact key.",
      });
    }

    const leading = this.#segmentNames.slice(0, present.length);
    if (present.join(this.#separator) !== leading.join(this.#separator)) {
      throw new InternalError({
        message: `list prefix must be a leading run of key segments [${this.#segmentNames.join(", ")}]; got [${present.join(", ")}].`,
      });
    }
    const segments = leading.map((name) => this.#segment(name, provided[name]));
    return `${[this.#prefix, ...segments].join(this.#separator)}${this.#separator}`;
  }

  /** Split a physical key back into its named segments. Safe: segments never contain the separator. */
  #splitKey(name: string): Record<keyof z.input<K>, string> {
    const body = name.slice(this.#prefix.length + this.#separator.length);
    const segments = body.split(this.#separator);
    const out = {} as Record<keyof z.input<K>, string>;
    this.#segmentNames.forEach((segmentName, index) => {
      out[segmentName as keyof z.input<K>] = segments[index] ?? "";
    });
    return out;
  }

  /** Validate stored metadata against the schema; `null` when absent or unconfigured. */
  #parseMetadata(raw: unknown): z.output<M> | null {
    if (this.#metadataSchema === undefined || raw === null || raw === undefined) return null;
    return this.#metadataSchema.parse(raw) as z.output<M>;
  }
}
