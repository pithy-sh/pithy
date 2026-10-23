// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, type SqlBool, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The one index this adds: at most one `purged` row per account. */
const PURGED_ONCE_INDEX = "pithyAuthUserLifecyclePurgedOnceIdx";

/**
 * The purge, once (#622): what a deletion asked of its last mail, and a constraint that a purge finishes once.
 *
 * **`notify` on `pithy_auth_user_lifecycle`.** A hard deletion with `notify: false` asks the purge to send no
 * deletion-complete mail, and the purge that sends it is not always the one the deletion started: with no
 * purge Workflow bound, or a start that failed, the daily pass starts it, and the pass has no request to read
 * the choice from. So the deletion's own history row carries it, and the purge reads it there. `1` or `0` on a
 * hard deletion's `deleted` row that named it; null on every other row, and on one that did not.
 *
 * **A unique partial index on `userId` where `action` is `purged`.** Two purges of one account can overlap —
 * the daily pass and a hard deletion's own, or a purge still retrying when the next pass starts another — and
 * both reach `complete`. A read-then-insert lets both write the record, and both fire `onUserPurged`. With the
 * index the insert is the check: the one that lands fires, the other finds the row there and does nothing.
 *
 * **A `0005`, appended.** `0004` has shipped. No backfill, and no duplicate to clean up first: nothing before
 * this release ran a purge, so no account has a `purged` row yet.
 */
export const auth_0005_purge_once: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthUserLifecycle").addColumn("notify", "integer").execute();
    await db.schema
      .createIndex(PURGED_ONCE_INDEX)
      .on("pithyAuthUserLifecycle")
      .column("userId")
      .unique()
      .where(sql<SqlBool>`action = 'purged'`)
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(PURGED_ONCE_INDEX).execute();
    await db.schema.alterTable("pithyAuthUserLifecycle").dropColumn("notify").execute();
  },
};
