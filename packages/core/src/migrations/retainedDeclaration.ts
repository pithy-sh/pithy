// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration } from "kysely/migration";

/**
 * **Where a retained declaration is kept: on the `down` that would destroy the table (#588).**
 *
 * A capability says which of its tables are retained (`DatabaseSpec.retained`). The runner has to know it
 * at the moment a `down` is about to run, and by then all it holds is a `MigrationProvider` — Kysely's
 * interface, rebuilt by the registry, merged by the fan-out, wrapped by `batchedProvider`, and written by
 * hand in every capability's own migration tests. A declaration kept on any of those objects is lost the
 * first time somebody builds a new one.
 *
 * The `down` function survives all of that. A registry keeps the capability's migration object; a spread
 * that rebuilds the record keeps the same `down`; a hand-built provider in a test names the very
 * `secrets_0001_init` the capability ships. So the declaration is keyed on the function itself, and any
 * provider that yields it carries it.
 *
 * Kept apart from `./retained` so `defineCapability` can declare without importing Kysely's runtime.
 */

/** The destructive function → the retained table keys (camelCase, as `tables` declares them) it can drop. */
const DECLARED = new WeakMap<object, readonly string[]>();

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
  DECLARED.set(down, [...new Set([...(DECLARED.get(down) ?? []), ...tables])]);
}

/** The retained table keys declared on one `down`. */
export function retainedTablesOfDown(down: object): readonly string[] {
  return DECLARED.get(down) ?? [];
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
