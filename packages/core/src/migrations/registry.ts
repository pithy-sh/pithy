import type { Migration, MigrationProvider } from "kysely/migration";

/** Width of the zero-padded `order` prefix in a composed key — the stable anchor. */
const ORDER_DIGITS = 4;

/** Maximum per-capability `order`, derived from the prefix width so the two never drift. */
export const MAX_MIGRATION_ORDER = 10 ** ORDER_DIGITS - 1;

/** Capability namespace: lowercase, starts with a letter, no separators (keeps keys injective). */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*$/;

/** Local migration key: a zero-padded sequence + lowercase snake, e.g. "0001_init". */
const LOCAL_KEY_PATTERN = /^\d{4}_[a-z0-9_]+$/;

export interface NamespacedMigrations {
  /** Capability namespace, e.g. "core", "auth", "app". Must match `^[a-z][a-z0-9]*$`. */
  namespace: string;
  /** Global sort order (core low, app high). Unique across the set; 0..MAX_MIGRATION_ORDER. */
  order: number;
  /** Stable, per-namespace keys, each `^\d{4}_[a-z0-9_]+$` (e.g. "0001_init"). */
  migrations: Record<string, Migration>;
}

function assertValidNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`migration namespace "${namespace}" must match ${NAMESPACE_PATTERN}`);
  }
}

function assertValidOrder(order: number, namespace: string): void {
  if (!Number.isInteger(order) || order < 0 || order > MAX_MIGRATION_ORDER) {
    throw new Error(
      `migration order ${order} (namespace "${namespace}") must be an integer in 0..${MAX_MIGRATION_ORDER}`,
    );
  }
}

function assertValidLocalKey(localKey: string, namespace: string): void {
  if (!LOCAL_KEY_PATTERN.test(localKey)) {
    throw new Error(`migration key "${localKey}" (namespace "${namespace}") must match ${LOCAL_KEY_PATTERN}`);
  }
}

/**
 * Merge namespaced migration sets into one `MigrationProvider` with stable, globally-sortable
 * keys `NNNN_<namespace>_<localKey>` (NNNN = zero-padded `order`). Kysely orders migrations by
 * name (`localeCompare`); the enforced namespace/key formats keep that sort equal to a plain
 * lexicographic one and dependency-correct (core before app), and make the key scheme injective.
 * Keys never change across releases — new migrations append within a namespace — so Kysely's
 * recorded names stay valid and an upgrade ships migrations without renumbering.
 */
export function createMigrationRegistry(sets: NamespacedMigrations[]): MigrationProvider {
  const seenOrders = new Set<number>();
  const seenNamespaces = new Set<string>();

  for (const set of sets) {
    assertValidNamespace(set.namespace);
    assertValidOrder(set.order, set.namespace);
    for (const localKey of Object.keys(set.migrations)) assertValidLocalKey(localKey, set.namespace);
    if (seenOrders.has(set.order)) {
      throw new Error(`duplicate migration order ${set.order} (namespace "${set.namespace}")`);
    }
    if (seenNamespaces.has(set.namespace)) {
      throw new Error(`duplicate namespace "${set.namespace}"`);
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
