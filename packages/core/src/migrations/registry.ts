// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration, MigrationProvider } from "kysely/migration";
import { InternalError } from "../error/pithyError";
import { declareRetained } from "./retainedDeclaration";

/** Width of the zero-padded `order` prefix in a composed key — the stable anchor. */
const ORDER_DIGITS = 4;

/** Maximum per-capability `order`, derived from the prefix width so the two never drift. */
export const MAX_MIGRATION_ORDER = 10 ** ORDER_DIGITS - 1;

/** Capability namespace: lowercase, starts with a letter, no separators (keeps keys injective). */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*$/;

/** Local migration key: a zero-padded sequence + lowercase snake, e.g. "0001_init". */
const LOCAL_KEY_PATTERN = /^\d{4}_[a-z0-9_]+$/;

export interface NamespacedMigrations {
  /**
   * Target database name — the same name used in a capability's `databases:` map (e.g. "app",
   * "analytics"). D1 is multi-database; each database migrates independently, so every set names
   * the database it belongs to. A capability with tables in two databases contributes one set per.
   */
  database: string;
  /** Capability namespace, e.g. "core", "auth", "app". Must match `^[a-z][a-z0-9]*$`. */
  namespace: string;
  /** Sort order within its database (core low, app high). Unique per database; 0..MAX_MIGRATION_ORDER. */
  order: number;
  /** Stable, per-namespace keys, each `^\d{4}_[a-z0-9_]+$` (e.g. "0001_init"). */
  migrations: Record<string, Migration>;
  /**
   * The table keys (camelCase, as the capability's `tables` declares them) this set's capability retains
   * in this database — rows that exist nowhere else. Recorded on this set's `down`s, and the runner refuses
   * any `down` against the database while one of them holds rows. See `./retained`.
   */
  retained?: readonly string[];
}

// These guard build-time registry invariants — a capability author wired its migrations wrong.
// They surface at startup/build, not per request, so the offending value rides in the message.
function assertValidNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new InternalError({ message: `migration namespace "${namespace}" must match ${NAMESPACE_PATTERN}` });
  }
}

function assertValidOrder(order: number, namespace: string): void {
  if (!Number.isInteger(order) || order < 0 || order > MAX_MIGRATION_ORDER) {
    throw new InternalError({
      message: `migration order ${order} (namespace "${namespace}") must be an integer in 0..${MAX_MIGRATION_ORDER}`,
    });
  }
}

function assertValidLocalKey(localKey: string, namespace: string): void {
  if (!LOCAL_KEY_PATTERN.test(localKey)) {
    throw new InternalError({
      message: `migration key "${localKey}" (namespace "${namespace}") must match ${LOCAL_KEY_PATTERN}`,
    });
  }
}

/**
 * The composed key for one of a set's migrations: `NNNN_<namespace>_<localKey>`. The one place the shape is
 * written, so the registry and anything naming a declared migration's namespace build the same string.
 */
export function composedMigrationKey(set: Pick<NamespacedMigrations, "order" | "namespace">, localKey: string): string {
  return `${String(set.order).padStart(ORDER_DIGITS, "0")}_${set.namespace}_${localKey}`;
}

/** A composed key taken back apart: the three parts {@link createMigrationRegistry} joined. */
export interface ComposedMigrationKey {
  /** The capability's `migrationOrder` — the zero-padded prefix, as a number. */
  order: number;
  /** The capability namespace — its `name`, which the manifest reports beside every capability. */
  namespace: string;
  /** The capability's own stable key, e.g. `0001_init`. */
  localKey: string;
}

/**
 * The composed key shape, anchored at both ends: the order prefix, a namespace (which admits no separator,
 * so the first underscore after it is the boundary), then a local key, which may hold any number.
 */
const COMPOSED_KEY_PATTERN = new RegExp(
  `^(\\d{${ORDER_DIGITS}})_(${NAMESPACE_PATTERN.source.slice(1, -1)})_(${LOCAL_KEY_PATTERN.source.slice(1, -1)})$`,
);

/**
 * Take a composed key back apart — the inverse of the composition below.
 *
 * A declared migration's namespace is known from the set it came from. An **undeclared** one — applied in
 * the database, carried by no provider this build composes — has nothing but its key, so this is the only
 * way to say whose it was. **Null for a key no registry could have composed**, a migration written by hand
 * or by another tool: guessing a namespace for it would be inventing one.
 *
 * The patterns are the same constants the composition enforces, so the two cannot disagree about what a
 * key looks like.
 */
export function decomposeMigrationKey(key: string): ComposedMigrationKey | null {
  const match = COMPOSED_KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, order, namespace, localKey] = match;
  if (order === undefined || namespace === undefined || localKey === undefined) return null;
  return { order: Number(order), namespace, localKey };
}

/** Merge one database's sets into a provider, enforcing the per-database invariants. */
function composeDatabase(database: string, sets: NamespacedMigrations[]): MigrationProvider {
  const seenOrders = new Set<number>();
  const seenNamespaces = new Set<string>();

  for (const set of sets) {
    assertValidNamespace(set.namespace);
    assertValidOrder(set.order, set.namespace);
    for (const localKey of Object.keys(set.migrations)) assertValidLocalKey(localKey, set.namespace);
    if (seenOrders.has(set.order)) {
      throw new InternalError({
        message: `duplicate migration order ${set.order} in database "${database}" (namespace "${set.namespace}")`,
      });
    }
    if (seenNamespaces.has(set.namespace)) {
      throw new InternalError({ message: `duplicate namespace "${set.namespace}" in database "${database}"` });
    }
    seenOrders.add(set.order);
    seenNamespaces.add(set.namespace);
  }

  const composed: Record<string, Migration> = {};
  for (const set of [...sets].sort((a, b) => a.order - b.order)) {
    for (const localKey of Object.keys(set.migrations).sort()) {
      const migration = set.migrations[localKey];
      if (migration) composed[composedMigrationKey(set, localKey)] = migration;
    }
  }

  // Recorded on each migration's own `down`, so the runner enforces it on this provider and on anything
  // later built from these same migrations — no caller has to remember to pass it along (#588).
  for (const set of sets) declareRetained(set.migrations, set.retained ?? []);
  return {
    getMigrations: async (): Promise<Record<string, Migration>> => composed,
  };
}

/**
 * Merge namespaced migration sets into one ordered `MigrationProvider` **per database** — matching
 * multi-database D1, where each `c.var.db.<database>` is its own binding and schema. The result is
 * keyed by database name (the future `pithy migrate` maps each to its binding and runs its provider);
 * an empty input yields `{}`.
 *
 * Within each database the keys are `NNNN_<namespace>_<localKey>` (NNNN = zero-padded `order`).
 * Kysely orders migrations by name (`localeCompare`); the enforced namespace/key formats keep that
 * sort equal to a plain lexicographic one and dependency-correct (core before app), and make the key
 * scheme injective. Keys never change across releases — new migrations append within a namespace — so
 * Kysely's recorded names stay valid and an upgrade ships migrations without renumbering.
 *
 * `order` and `namespace` uniqueness scope **per database**: the same value may recur across
 * different databases; a duplicate within one database throws.
 */
export function createMigrationRegistry(sets: NamespacedMigrations[]): Record<string, MigrationProvider> {
  const byDatabase = new Map<string, NamespacedMigrations[]>();
  for (const set of sets) {
    const group = byDatabase.get(set.database);
    if (group) group.push(set);
    else byDatabase.set(set.database, [set]);
  }

  const registry: Record<string, MigrationProvider> = {};
  for (const [database, dbSets] of byDatabase) {
    registry[database] = composeDatabase(database, dbSets);
  }
  return registry;
}
