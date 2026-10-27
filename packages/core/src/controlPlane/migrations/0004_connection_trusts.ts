// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * A connection's OIDC trusts — `#722`, the second credential kind beside a registered key.
 *
 * **Appended, not folded into `0001`.** The seam has shipped and adopters' databases hold rows written by it.
 *
 * **One JSON column beside `keys`, defaulting to an empty list.** The same reasons `keys` is one column rather
 * than a child table: verifying a call stays a single read, and revoking a trust is one `UPDATE`. Not null,
 * with `'[]'` as its default, so every existing row reads as a connection holding no trust — which is exactly
 * what it is — and nothing is backfilled.
 */
export const controlplane_0004_connection_trusts: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .alterTable("pithyControlplaneConnections")
      .addColumn("trusts", "text", (column) => column.notNull().defaultTo("[]"))
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    // Dropped in place, for the reason `0002` gives: a rebuild would rewrite every row of a table holding live
    // credentials. Every key on the row survives; the trusts go with their column.
    await db.schema.alterTable("pithyControlplaneConnections").dropColumn("trusts").execute();
  },
};
