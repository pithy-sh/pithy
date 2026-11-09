// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";

/**
 * **Where a retained declaration is kept: on the `down` that would destroy the table.**
 *
 * A capability says which of its tables are retained (`DatabaseSpec.retained`). The runner has to know it
 * at the moment a `down` is about to run, and by then all it holds is a `MigrationProvider` — Kysely's
 * interface, rebuilt by the registry, merged by the fan-out, wrapped by `batchedProvider`, and written by
 * hand in every capability's own migration tests. A declaration kept on any of those objects is lost the
 * first time somebody builds a new one.
 *
 * The `down` function survives all of that. A registry keeps the capability's migration object; a spread
 * that rebuilds the record keeps the same `down`; a hand-built provider in a test names the very
 * `secrets_0001_init` the capability ships. So the declaration is a property of the function itself, and
 * any provider that yields it carries it. The CLI reads a project's declarations with its own copy of
 * core, so the key is global.
 *
 * Kept apart from `./retained` so `defineCapability` can declare without importing Kysely's runtime.
 */

/** The key a destructive `down` carries its retained table keys under. Global, so two copies of core agree. */
export const RETAINED_TABLES = Symbol.for("pithy.retainedTables");

/** Declarations on a `down` that cannot take the property, such as a frozen one. Read by this copy alone. */
const UNMARKABLE = new WeakMap<object, readonly string[]>();

/** Record that every `down` in `migrations` runs against a database holding these retained tables. */
export function declareRetained(migrations: Readonly<Record<string, Migration>>, tables: readonly string[]): void {
  if (tables.length === 0) return;
  for (const migration of Object.values(migrations)) {
    if (migration.down) declareRetainedDown(migration.down, tables);
  }
}

/** Record one `down` — for a wrapper that replaces a declared `down` with its own function. */
export function declareRetainedDown(down: object, tables: readonly string[]): void {
  if (tables.length === 0) return;
  const value = [...new Set([...retainedTablesOfDown(down), ...tables])];
  const own = Object.getOwnPropertyDescriptor(down, RETAINED_TABLES);
  if (own ? own.configurable : Object.isExtensible(down)) {
    Object.defineProperty(down, RETAINED_TABLES, { value, configurable: true });
  } else {
    UNMARKABLE.set(down, value);
  }
}

/** The retained table keys (camelCase, as `tables` declares them) declared on one `down`. */
export function retainedTablesOfDown(down: object): readonly string[] {
  const tables: unknown = UNMARKABLE.get(down) ?? Object.getOwnPropertyDescriptor(down, RETAINED_TABLES)?.value;
  return Array.isArray(tables) ? tables.filter((table): table is string => typeof table === "string") : [];
}

/**
 * The retained table keys any migration in a set declares — the database-wide answer, since a `down` is
 * refused for rows in *any* retained table of the database it runs against.
 */
export function retainedTablesOf(migrations: Readonly<Record<string, Migration>>): string[] {
  const tables = new Set<string>();
  for (const migration of Object.values(migrations)) {
    if (!migration.down) continue;
    for (const table of retainedTablesOfDown(migration.down)) tables.add(table);
  }
  return [...tables].sort();
}
