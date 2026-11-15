// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * `basis_key` on `pithy_auth_user_lifecycle`: the catalog key a retained step's basis translates through, beside the
 * English basis in `reason`. Null on every other row, on a retained step that names no key, and on one recorded
 * before this ran. Appended: the chain is released history.
 */
export const auth_0011_retained_basis_key: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthUserLifecycle").addColumn("basisKey", "text").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthUserLifecycle").dropColumn("basisKey").execute();
  },
};
