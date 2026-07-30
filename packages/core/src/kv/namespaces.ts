// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace } from "@cloudflare/workers-types";
import type { z } from "zod";
import type { Capability } from "../capability/capability";
import { type BindingGroup, bindingGroupsFrom, composeBindingGroups } from "../capability/compose";
import type { Logger } from "../logger/logger";
import { noopLogger } from "../logger/logger";
import { TypedKv, type TypedKvConfig } from "./kv";

/**
 * One typed store within a KV namespace — a {@link TypedKvConfig} (prefix, key, value, metadata).
 * The peer of a D1 table: the binding lives on the enclosing namespace, not the store.
 */
export type KvStoreSpec<
  V extends z.ZodType = z.ZodType,
  K extends z.ZodObject = z.ZodObject,
  M extends z.ZodType = z.ZodType,
> = TypedKvConfig<V, K, M>;

/** A capability's stores for one namespace: store name → {@link KvStoreSpec}. */
export type KvStoreSpecMap = Record<string, KvStoreSpec>;

/**
 * One named KV namespace a capability registers — the peer of a {@link DatabaseSpec}: the `binding`
 * it lives in plus the named stores it holds. `createBackend` serves each store as a live
 * {@link TypedKv} on `c.var.kv.<namespace>.<store>`. Capabilities targeting the same namespace name
 * merge their stores.
 */
export interface KvNamespaceSpec<Stores extends KvStoreSpecMap = KvStoreSpecMap> {
  /** The KV binding name in the Worker env this namespace lives in. */
  binding: string;
  /** The named typed stores in this namespace (store name → spec). */
  stores: Stores;
}

/** A capability's KV namespaces: namespace name → {@link KvNamespaceSpec}. */
export type KvNamespaceSpecMap = Record<string, KvNamespaceSpec>;

/**
 * The typed KV registry exposed on `c.var.kv`: namespace name → store name → live {@link TypedKv},
 * preserving each store's value/key/metadata types — so `c.var.kv.cms.pages.get(...)` returns the
 * page type, validated, and `c.var.kv.audit.pages` is a distinct store with no name conflict.
 */
export type KvRegistry<Namespaces extends KvNamespaceSpecMap> = {
  [Ns in keyof Namespaces]: Namespaces[Ns] extends KvNamespaceSpec<infer Stores>
    ? { [S in keyof Stores]: Stores[S] extends KvStoreSpec<infer V, infer K, infer M> ? TypedKv<V, K, M> : never }
    : never;
};

/** The merged namespaces: each namespace name → its binding and the union of every capability's stores. */
export type MergedKvNamespaces = Record<string, BindingGroup<KvStoreSpec>>;

/**
 * Merge every capability's `kvNamespaces` into one map keyed by namespace name. Capabilities
 * targeting the same name union their stores; a store claimed twice in one namespace, or a namespace
 * name bound to two bindings, throws at assembly. Mirrors `composeDatabases`.
 */
export function composeKv(capabilities: Capability[]): MergedKvNamespaces {
  return composeBindingGroups<KvStoreSpec>(
    capabilities,
    (cap) => bindingGroupsFrom(cap.kvNamespaces, (ns) => ns.stores),
    "KV namespace",
    "store",
  );
}

/** A registry of live stores keyed by namespace then store name; the per-request value of `c.var.kv`. */
type LiveStore = TypedKv<z.ZodType, z.ZodObject, z.ZodType>;
type LiveKvRegistry = Record<string, Record<string, LiveStore>>;

/**
 * Build the per-request KV registry from the merged namespaces and the request's env. Each store is
 * constructed lazily on first access — a request that never touches `c.var.kv.cms.fragments` never
 * builds it (mirroring Leed's lazy `KVProvider` getters) — and the namespace's binding is read from
 * the per-request env at access time. `logger` is the request logger (`c.var.log`) each store routes
 * its observable best-effort failures through — notably the `list` self-heal write-back; it defaults to
 * the no-op logger so a store built outside a request still constructs.
 */
export function buildKvRegistry(
  env: Record<string, unknown>,
  namespaces: MergedKvNamespaces,
  logger: Logger = noopLogger,
): LiveKvRegistry {
  const registry: LiveKvRegistry = {};
  for (const [namespace, group] of Object.entries(namespaces)) {
    const stores: Record<string, LiveStore> = {};
    for (const [name, spec] of Object.entries(group.items)) {
      let instance: LiveStore | undefined;
      Object.defineProperty(stores, name, {
        enumerable: true,
        get(): LiveStore {
          if (!instance) instance = new TypedKv(env[group.binding] as KVNamespace, spec, { logger });
          return instance;
        },
      });
    }
    registry[namespace] = stores;
  }
  return registry;
}
