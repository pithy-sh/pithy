// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * An organization's seat limit (#624): how many memberships the account may hold.
 *
 * **One nullable column on `pithy_organization_organizations`, with no backfill.** Every account that
 * exists when this runs has no limit, and null is exactly that. The rule it holds lives in the writers —
 * an operator's add counts against it and may override it, and an accepted invitation is refused against
 * a full account — because a limit is a decision about the roster, and the roster is the writers'.
 *
 * **A `0002`, appended, never folded into `0001`.** `@pithy-sh/organization` has shipped, so its chain is
 * history.
 */
export const organization_0002_seat_limit: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyOrganizationOrganizations").addColumn("seatLimit", "integer").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // The exact inverse. SQLite has supported `DROP COLUMN` since 3.35, which D1 is well past.
    await db.schema.alterTable("pithyOrganizationOrganizations").dropColumn("seatLimit").execute();
  },
};
