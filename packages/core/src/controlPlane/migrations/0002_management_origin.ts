// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Where the management client that registered a connection answers — `#614`.
 *
 * **Appended, not folded into `0001`.** The seam has shipped and adopters' databases hold rows written
 * by it; a column added to the initial migration is history rewritten under a ledger that already
 * records `0001_init` as applied. So this is a second migration, and `0001` stays what it was.
 *
 * **Nullable, with no default.** Every other address on the row has an obvious value when it is absent
 * — a seam is mounted somewhere, so `basePath` defaults. An origin does not: a row written before this
 * column knows only what its dashboard *signs* as, and defaulting it to the hosted origin would assert
 * that every existing self-hosted connection belongs to `app.pithy.sh`. That is the assertion that
 * caused #614 in the first place. Null means "not recorded", the CLI falls back to the issuer, and the
 * next `connect` writes the real answer.
 *
 * **The Worker never reads it.** Verification matches a token's `iss` against `issuer`; this column
 * exists for the operator's side, so that `status --verify`, `rotate` and `disconnect` call the
 * dashboard the connection was registered against rather than whichever one a flag's default names.
 */
export const controlplane_0002_management_origin: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyControlplaneConnections").addColumn("managementOrigin", "text").execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    // SQLite has dropped columns since 3.35 and D1 carries a newer engine, so the twelve-step rebuild is
    // not needed here — and a rebuild would be the riskier `down`, since it rewrites every row of a table
    // holding live credentials to remove a column nothing reads.
    await db.schema.alterTable("pithyControlplaneConnections").dropColumn("managementOrigin").execute();
  },
};
