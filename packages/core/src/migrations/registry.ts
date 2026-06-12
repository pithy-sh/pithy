import type { Migration, MigrationProvider } from "kysely/migration";
import { InternalError } from "../error/pithyError";

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
    const prefix = String(set.order).padStart(ORDER_DIGITS, "0");
    for (const localKey of Object.keys(set.migrations).sort()) {
      const migration = set.migrations[localKey];
      if (migration) composed[`${prefix}_${set.namespace}_${localKey}`] = migration;
    }
  }

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
