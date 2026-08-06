// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SeedSet } from "./seed";

/**
 * The run's own inventory: which rows a seed run declares, per table, before it writes any of them.
 *
 * It exists for the one class of fixture that has to agree with a row another set owns — a dev session for a
 * seeded user, say. Such a set cannot hard-code the roster (the users may be an adopter's, not a library's)
 * and must not read the database (a capability module is bundled into the Worker, where D1 is a binding it
 * has no business opening during a seed). So the CLI hands it the composed registry it already holds in
 * memory. It is a *plan*, not a query: no I/O, no credentials, and the same answer in a dry run.
 */

/**
 * Read the app-shape rows this run declares for one `database`.`table`, across every composed set. Empty
 * when nothing seeds that table. Values are `unknown` on purpose — they cross into a capability that does
 * not own the table, so the reader validates them with the schema it expects.
 */
export type SeededRows = (database: string, table: string) => readonly unknown[];

/**
 * Index every set's statically declared D1 rows into one lookup, in composed order.
 *
 * Statically declared, and only that. A prepared set's rows do not exist until its own `prepare` runs, and a
 * media record's row has no id until the CLI mints one — reporting either would promise a row that may never
 * land. A set that needs to be *seen* must therefore declare its rows as literals, which every user fixture
 * does.
 */
export function collectSeededRows(sets: readonly SeedSet[]): SeededRows {
  const index = new Map<string, Map<string, unknown[]>>();
  for (const set of sets) {
    for (const group of set.d1 ?? []) {
      const tables = index.get(group.database) ?? new Map<string, unknown[]>();
      index.set(group.database, tables);
      tables.set(group.table, [...(tables.get(group.table) ?? []), ...group.rows]);
    }
  }
  return (database, table) => index.get(database)?.get(table) ?? [];
}
