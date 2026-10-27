// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, type SqlBool, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The period read's index: every erasure row written in a window. */
const CREATED_INDEX = "pithyOrganizationLifecycleCreatedAtIdx";

/** The period read's other index: every deletion whose purge came due in a window. */
const PURGE_AFTER_INDEX = "pithyOrganizationLifecyclePurgeAfterIdx";

/**
 * The erasure record (#823): what a deletion asked for, kept where the purge cannot erase it.
 *
 * **`mode` and `purge_after` on `pithy_organization_lifecycle`**, the shape `@pithy-sh/auth`'s `0007_erasure_record`
 * gives a user's. The attestation says whether a deletion was soft or hard and when its purge came due, and the purge
 * erases the organization's own row. Null on every other row, and on a deletion recorded before this ran.
 *
 * **Two indexes for the period read.** **A `0004`, appended.** `@pithy-sh/organization` has shipped. No backfill.
 */
export const organization_0004_erasure_record: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("pithyOrganizationLifecycle").addColumn("mode", "text").execute();
    await db.schema.alterTable("pithyOrganizationLifecycle").addColumn("purgeAfter", "integer").execute();
    await db.schema.createIndex(CREATED_INDEX).on("pithyOrganizationLifecycle").column("createdAt").execute();
    await db.schema
      .createIndex(PURGE_AFTER_INDEX)
      .on("pithyOrganizationLifecycle")
      .column("purgeAfter")
      .where(sql<SqlBool>`purge_after is not null`)
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(PURGE_AFTER_INDEX).execute();
    await db.schema.dropIndex(CREATED_INDEX).execute();
    await db.schema.alterTable("pithyOrganizationLifecycle").dropColumn("purgeAfter").execute();
    await db.schema.alterTable("pithyOrganizationLifecycle").dropColumn("mode").execute();
  },
};
