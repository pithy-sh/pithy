// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, type SqlBool, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** The four state columns, in the order `up` adds them and `down` takes them away in reverse. */
const STATE_COLUMNS = ["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"] as const;

/** An organization's history, newest first — the one read the table serves. */
const HISTORY_INDEX = "pithyOrganizationLifecycleOrgIdx";

/** At most one `purged` row per organization, so a purge finishes once however many overlap. */
const PURGED_ONCE_INDEX = "pithyOrganizationLifecyclePurgedOnceIdx";

/** The daily pass's read: the deleted organizations whose window has closed, oldest first. */
const PURGE_DUE_INDEX = "pithyOrganizationOrganizationsPurgeAfterIdx";

/**
 * The organization lifecycle (#623): whether an organization is suspended or deleted, and the record of how it
 * got there.
 *
 * **Four columns on `pithy_organization_organizations`**, the same four `@pithy-sh/auth` puts on a user, so the
 * read that already joins a membership to its organization carries the state and refusing a suspended one
 * costs no extra query. Nullable, with no backfill: every organization that exists when this runs is in
 * neither state, and null is exactly that.
 *
 * **One kit-owned table beside them, `pithy_organization_lifecycle`**, holding every transition with its actor,
 * its reason and its time. No foreign key to the organization: a purge erases that row, and this table is the
 * record that must outlive it (`../data/organizationLifecycle.ts`). Its unique partial index on
 * `organization_id` where `action` is `purged` makes the purge's last record its own check — the shape auth's
 * `0005_purge_once` gave a user's.
 *
 * **A `0003`, appended, never folded into `0001`.** `@pithy-sh/organization` has shipped, so its chain is
 * history.
 */
export const organization_0003_organization_lifecycle: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const column of STATE_COLUMNS) {
      await db.schema.alterTable("pithyOrganizationOrganizations").addColumn(column, "integer").execute();
    }
    await db.schema
      .createIndex(PURGE_DUE_INDEX)
      .on("pithyOrganizationOrganizations")
      .column("purgeAfter")
      .where(sql<SqlBool>`purge_after is not null`)
      .execute();
    await db.schema
      .createTable("pithyOrganizationLifecycle")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("organizationId", "text", (c) => c.notNull())
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("actorType", "text", (c) => c.notNull())
      .addColumn("actorId", "text")
      .addColumn("reason", "text")
      .addColumn("suspendedUntil", "integer")
      .addColumn("step", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();
    // The trailing id orders two transitions written in the same millisecond the way they were written.
    await db.schema
      .createIndex(HISTORY_INDEX)
      .on("pithyOrganizationLifecycle")
      .columns(["organizationId", "id"])
      .execute();
    await db.schema
      .createIndex(PURGED_ONCE_INDEX)
      .on("pithyOrganizationLifecycle")
      .column("organizationId")
      .unique()
      .where(sql<SqlBool>`action = 'purged'`)
      .execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // The exact inverse. Nothing else references this table or these columns, and SQLite has supported
    // `DROP COLUMN` since 3.35, which D1 is well past.
    await db.schema.dropIndex(PURGED_ONCE_INDEX).ifExists().execute();
    await db.schema.dropIndex(HISTORY_INDEX).ifExists().execute();
    await db.schema.dropTable("pithyOrganizationLifecycle").ifExists().execute();
    await db.schema.dropIndex(PURGE_DUE_INDEX).ifExists().execute();
    for (const column of [...STATE_COLUMNS].reverse()) {
      await db.schema.alterTable("pithyOrganizationOrganizations").dropColumn(column).execute();
    }
  },
};
