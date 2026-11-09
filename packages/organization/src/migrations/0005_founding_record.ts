// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** The purge's read: every founding record of one organization. */
const ORGANIZATION_INDEX = "pithyOrganizationFoundingsOrgIdx";

/**
 * The founding record: which organization an idempotency key founded, and what the request asked for, so a
 * repeat of `POST /organizations` answers the organization it already founded.
 *
 * **The primary key is `(founderUserId, idempotencyKey)`**, and it is what decides between two concurrent
 * foundings carrying one key. No foreign key to the organization: `deleteOrganization` deletes the record in the
 * batch that deletes the organization.
 *
 * Appended as `0005`: `@pithy-sh/organization` has shipped. No backfill, because no founding before this carried
 * a key.
 */
export const organization_0005_founding_record: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("pithyOrganizationFoundings")
      .addColumn("founderUserId", "text", (c) => c.notNull())
      .addColumn("idempotencyKey", "text", (c) => c.notNull())
      .addColumn("organizationId", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("slug", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("pithyOrganizationFoundingsPk", ["founderUserId", "idempotencyKey"])
      .execute();
    await db.schema.createIndex(ORGANIZATION_INDEX).on("pithyOrganizationFoundings").column("organizationId").execute();
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex(ORGANIZATION_INDEX).ifExists().execute();
    await db.schema.dropTable("pithyOrganizationFoundings").ifExists().execute();
  },
};
