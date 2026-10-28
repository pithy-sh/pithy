// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The inactivity pass's index: every account by when it was last active. */
const LAST_ACTIVE_INDEX = "pithyAuthUsersLastActiveAtIdx";

/**
 * When an account was last active — stamped on `pithy_auth_users` by every session the account opens, so the
 * retention policy's class ages have a clock that a sign-out cannot erase: a session row goes when its holder signs
 * out, and this column stays.
 *
 * **Every existing account starts its clock now.** A row written before this column existed has no record of its
 * last sign-in, and reading its absence as "never" would soft-delete an account somebody used last week the first
 * night the pass runs. So `up` stamps the migration's own instant on every row, and an account becomes inactive no
 * sooner than its class age after the upgrade. `down` drops the column and the index.
 */
export const auth_0008_last_active: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthUsers").addColumn("lastActiveAt", "integer").execute();
    await sql`update pithy_auth_users set last_active_at = cast(strftime('%s', 'now') as integer) * 1000`.execute(db);
    await db.schema.createIndex(LAST_ACTIVE_INDEX).on("pithyAuthUsers").column("lastActiveAt").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(LAST_ACTIVE_INDEX).execute();
    await db.schema.alterTable("pithyAuthUsers").dropColumn("lastActiveAt").execute();
  },
};
