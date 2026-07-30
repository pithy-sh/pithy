// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { fromZodError } from "../error/pithyError";
import type { TypedKv } from "../kv/kv";
import type { KvStoreSpec } from "../kv/namespaces";
import type { KvSeedGroup } from "./seed";

/** Options for {@link seedKvGroup}. */
export interface SeedKvOptions {
  /** Count only; perform no write. */
  dryRun?: boolean;
}

/** The outcome of seeding one KV group. */
export interface SeedKvResult {
  /** The store seeded. */
  store: string;
  /** The number of entries validated (and, unless `dryRun`, considered for writing). */
  entries: number;
}

/**
 * Validate one entry's key, value, and (present) metadata against the store spec, mapping a
 * `ZodError` into an actionable `ValidationError`. Pure — never writes.
 */
function validateEntry<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType>(
  spec: KvStoreSpec<V, K, M>,
  group: KvSeedGroup<V, K, M>,
  entry: KvSeedGroup<V, K, M>["entries"][number],
  index: number,
): void {
  try {
    spec.key.parse(entry.key);
    spec.value.parse(entry.value);
    if (entry.metadata !== undefined && spec.metadata !== undefined) spec.metadata.parse(entry.metadata);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw fromZodError(error, {
        message: `Invalid seed entry for KV store "${group.store}".`,
        action: "Fix the fixture so every entry matches the store's key, value, and metadata schemas.",
        detail: `Entry ${index} for namespace "${group.namespace}" store "${group.store}" failed validation.`,
      });
    }
    throw error;
  }
}

/**
 * Whether `key` already holds a value — used to make the write non-destructive. A value that exists but
 * no longer parses against the store schema (foreign or older data at a colliding key) still counts as
 * present: existence, not readability, is what the "never overwrite" guarantee turns on.
 */
async function keyExists<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType>(
  store: TypedKv<V, K, M>,
  key: z.input<K>,
): Promise<boolean> {
  try {
    return (await store.get(key)) !== null;
  } catch {
    return true;
  }
}

/**
 * Seed one KV group, idempotently and non-destructively.
 *
 * **Every entry is validated against the store spec before any write** — mirroring `seedD1Group`, an
 * invalid fixture throws a `ValidationError` (a `ZodError` mapped via `fromZodError`) before the first
 * `put`, so a partial group never lands. The write itself is non-destructive: an existing key is left
 * untouched (KV's analog of D1's `INSERT OR IGNORE`), so re-running a seed never overwrites real data
 * that happens to share a key, and re-establishes only the keys it owns.
 *
 * `dryRun` validates and counts but writes nothing.
 */
export async function seedKvGroup<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType>(
  store: TypedKv<V, K, M>,
  group: KvSeedGroup<V, K, M>,
  spec: KvStoreSpec<V, K, M>,
  options: SeedKvOptions = {},
): Promise<SeedKvResult> {
  // Validate the whole group up front, before any write, so an invalid entry never leaves earlier
  // entries persisted.
  group.entries.forEach((entry, index) => {
    validateEntry(spec, group, entry, index);
  });

  if (options.dryRun) {
    return { store: group.store, entries: group.entries.length };
  }

  for (const entry of group.entries) {
    // Never overwrite an existing key — the KV counterpart of D1's INSERT OR IGNORE.
    if (await keyExists(store, entry.key)) continue;
    await store.put(entry.key, entry.value, entry.metadata !== undefined ? { metadata: entry.metadata } : {});
  }
  return { store: group.store, entries: group.entries.length };
}
