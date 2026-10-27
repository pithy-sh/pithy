// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, type SqlBool, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The period read's index: every erasure row written in a window. */
const CREATED_INDEX = "pithyAuthUserLifecycleCreatedAtIdx";

/** The period read's other index: every deletion whose purge came due in a window. */
const PURGE_AFTER_INDEX = "pithyAuthUserLifecyclePurgeAfterIdx";

/**
 * The erasure record (#823): what a deletion asked for, kept where the purge cannot erase it.
 *
 * **`mode` and `purge_after` on `pithy_auth_user_lifecycle`.** The attestation says whether a deletion was soft or
 * hard and when its purge came due. Both sat only on `pithy_auth_users`, as `purgeAfter`, or nowhere, and the purge
 * erases that row. So a `deleted` row now carries them: `soft` or `hard`, and the instant, ms-epoch. Null on every
 * other row, and on a deletion recorded before this ran — the attestation says so rather than guessing.
 *
 * **Two indexes for the period read**, which asks which purges came due, ran a step, failed or finished in a window.
 *
 * **A `0007`, appended.** `@pithy-sh/auth` has shipped, so its chain is history. No backfill.
 */
export const auth_0007_erasure_record: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyAuthUserLifecycle").addColumn("mode", "text").execute();
    await db.schema.alterTable("pithyAuthUserLifecycle").addColumn("purgeAfter", "integer").execute();
    await db.schema.createIndex(CREATED_INDEX).on("pithyAuthUserLifecycle").column("createdAt").execute();
    await db.schema
      .createIndex(PURGE_AFTER_INDEX)
      .on("pithyAuthUserLifecycle")
      .column("purgeAfter")
      .where(sql<SqlBool>`purge_after is not null`)
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(PURGE_AFTER_INDEX).execute();
    await db.schema.dropIndex(CREATED_INDEX).execute();
    await db.schema.alterTable("pithyAuthUserLifecycle").dropColumn("purgeAfter").execute();
    await db.schema.alterTable("pithyAuthUserLifecycle").dropColumn("mode").execute();
  },
};
