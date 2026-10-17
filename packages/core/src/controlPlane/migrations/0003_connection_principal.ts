// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Who sanctioned a connection, what kind of client it is, and what it is for — `#721`.
 *
 * **Appended, not folded into `0001`.** The seam has shipped and adopters' databases hold rows written by
 * it, so the three columns arrive in a migration of their own, as `0002`'s origin did.
 *
 * **Nullable, with no default, and nothing backfilled.** A row registered before this carries no
 * principal, and none can be recovered: most of the trail that might be mined for one names a token
 * rather than a person, and a principal read off a token name is the self-assertion this issue exists to
 * end. So null means *registered before principals were recorded*, the connection keeps working exactly
 * as it did, its purpose may be set with `pithy dashboard connect --update --purpose`, and its principal
 * is set only by registering again, under a signed-in session.
 *
 * **The Worker reads only `actorKind`**, to stamp it onto the audit rows a connection's calls write. The
 * other two exist for the adopter's own review, on their own side.
 */
export const controlplane_0003_connection_principal: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyControlplaneConnections").addColumn("authorizedBy", "text").execute();
    await db.schema.alterTable("pithyControlplaneConnections").addColumn("actorKind", "text").execute();
    await db.schema.alterTable("pithyControlplaneConnections").addColumn("purpose", "text").execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    // Dropped column by column, newest first, for the reason `0002` gives: D1's engine drops a column in
    // place, and a twelve-step rebuild would rewrite every row of a table holding live credentials.
    await db.schema.alterTable("pithyControlplaneConnections").dropColumn("purpose").execute();
    await db.schema.alterTable("pithyControlplaneConnections").dropColumn("actorKind").execute();
    await db.schema.alterTable("pithyControlplaneConnections").dropColumn("authorizedBy").execute();
  },
};
