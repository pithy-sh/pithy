// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The five tenancy tables: the organization, the memberships that grant access to it, the outstanding
 * invitations, the standing ownership offer, and each session's acting selection.
 *
 * Identifiers are camelCase throughout — `CamelCasePlugin` snake-cases the DDL. Dates are `integer`
 * ms-epoch and booleans are `integer` 0/1.
 *
 * **Shape and value rules live in the Zod schemas, not here.** One Zod object per table is the entire
 * table definition (CLAUDE.md §Data layer), so a slug's pattern, a name's bounds and an enum's members
 * are declared and enforced there — on `parse` *and* on `encode`, which is the boundary every write
 * already crosses. Restating them as `CHECK` constraints would buy a second source of truth that could
 * drift from the first, and would produce a raw `CHECK constraint failed` out of Kysely instead of a
 * `PithyError` with an action line.
 *
 * What stays is what Zod cannot express, because it is a fact about the table rather than about a row:
 * `UNIQUE` — a slug, one membership per person per organization, one invitation token, one acting row
 * per session — and the indexes the gates actually use.
 *
 * No foreign keys, matching the rest of the repo: D1 does not enforce them, so declaring them would be
 * documentation pretending to be a constraint. Referential integrity is held by the writers, and
 * deleting an organization deletes its children first.
 *
 * **`user_id` references a table this capability does not own.** `pithy_auth_users` belongs to
 * `@pithy-sh/auth`, versioned on its own release cadence, so the reference is a plain text column and
 * the join is made in query code — never a foreign key across a capability boundary, and never a column
 * added to somebody else's table.
 */
export const organization_0001_init: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyOrganizationOrganizations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("slug", "text", (c) => c.notNull())
      .addColumn("logo", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // A slug addresses one account. Unique at the table, because a handler that checked first and
      // wrote second would have a window between the two in which a second request could win.
      .addUniqueConstraint("pithyOrganizationOrganizationsSlugIdx", ["slug"])
      .execute();

    await db.schema
      .createTable("pithyOrganizationMemberships")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("organizationId", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // One row per person per organization. This is what makes a second invitation to somebody already
      // inside an idempotent no-op at the storage layer rather than only in the handler — two rows for
      // one person would split their role in half and make "what may they do here" a question with two
      // answers.
      .addUniqueConstraint("pithyOrganizationMembershipsPersonIdx", ["organizationId", "userId"])
      .execute();

    // The gate's own query: this person, in this organization. Both halves in one predicate, and this
    // is the index that serves it.
    await db.schema
      .createIndex("pithyOrganizationMembershipsUserIdx")
      .on("pithyOrganizationMemberships")
      .columns(["userId", "organizationId"])
      .execute();

    // The roster read, and the administrator count the last-administrator invariant runs.
    await db.schema
      .createIndex("pithyOrganizationMembershipsOrgRoleIdx")
      .on("pithyOrganizationMemberships")
      .columns(["organizationId", "role"])
      .execute();

    await db.schema
      .createTable("pithyOrganizationInvitations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("organizationId", "text", (c) => c.notNull())
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("invitedByUserId", "text", (c) => c.notNull())
      .addColumn("tokenDigest", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .addColumn("acceptedAt", "integer")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // The digest is the whole credential, so it is unique across every organization rather than
      // within one: a collision would let one person's link redeem another's offer.
      .addUniqueConstraint("pithyOrganizationInvitationsTokenIdx", ["tokenDigest"])
      .execute();

    // "What is outstanding for this account", and the lookup that refuses a second live offer to an
    // address already invited.
    await db.schema
      .createIndex("pithyOrganizationInvitationsOrgStatusIdx")
      .on("pithyOrganizationInvitations")
      .columns(["organizationId", "status", "email"])
      .execute();

    await db.schema
      .createTable("pithyOrganizationOwnershipNominations")
      // The organization *is* the key. One standing offer per account, as a constraint rather than as
      // care in a handler: two live nominations would make the second acceptance race the first for a
      // role only one person can hold.
      .addColumn("organizationId", "text", (c) => c.primaryKey())
      .addColumn("membershipId", "text", (c) => c.notNull())
      .addColumn("nominatedByUserId", "text", (c) => c.notNull())
      .addColumn("expiresAt", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // Removing a membership has to take any offer made to it with it, which is this lookup.
    await db.schema
      .createIndex("pithyOrganizationOwnershipNominationsMembershipIdx")
      .on("pithyOrganizationOwnershipNominations")
      .columns(["membershipId"])
      .execute();

    await db.schema
      .createTable("pithyOrganizationActing")
      // Keyed by the session, so signing out takes the selection with it and two browsers can look at
      // two different accounts.
      .addColumn("sessionId", "text", (c) => c.primaryKey())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("organizationId", "text", (c) => c.notNull())
      .addColumn("chosen", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("chosenAt", "integer", (c) => c.notNull())
      .execute();

    // Deleting an organization has to clear every session pointed at it.
    await db.schema
      .createIndex("pithyOrganizationActingOrgIdx")
      .on("pithyOrganizationActing")
      .columns(["organizationId"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    // Children first, and the acting rows before the organizations they name — the reverse of the
    // order above, so a partial `down` on a database D1 cannot roll back leaves nothing pointing at a
    // table that is already gone.
    await db.schema.dropTable("pithyOrganizationActing").ifExists().execute();
    await db.schema.dropTable("pithyOrganizationOwnershipNominations").ifExists().execute();
    await db.schema.dropTable("pithyOrganizationInvitations").ifExists().execute();
    await db.schema.dropTable("pithyOrganizationMemberships").ifExists().execute();
    await db.schema.dropTable("pithyOrganizationOrganizations").ifExists().execute();
  },
};

/**
 * Where tenancy's migrations sort in the app database. Unique per database; the registry composes keys
 * like `1400_organization_0001_init`.
 *
 * Taken from the `NEXT_FREE_ORDER` that `packages/cli/src/migrations/orders.test.ts` advertises, and
 * that constant bumped in the same change — never chosen by grepping. **Stable forever**: renumbering
 * renames the composed key, which makes Kysely treat an applied migration as unapplied and re-run it.
 *
 * Declared here rather than in `capability.ts` because `@pithy-sh/auth` does the same, and for the same
 * reason: the number is a fact about the migration, and it is read by the CLI's scanner out of source
 * text rather than by importing a module that needs config to build.
 */
export const ORGANIZATION_MIGRATION_ORDER = 1400;
