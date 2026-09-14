// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
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
 * **No foreign keys across a capability boundary — a choice, not a limitation.** D1 *does* enforce
 * them: `PRAGMA foreign_keys` is on, a cascade fires, and an orphan insert is refused with
 * `FOREIGN KEY constraint failed`. `packages/core/src/data/foreignKeys.workers.test.ts` measures both
 * directions, because this is the kind of claim that rots quietly. What is traded away is real, and the
 * reason is the boundary rather than the platform: a constraint from one capability's table to another's
 * binds two release cadences together and breaks the day either moves to its own database. Within a
 * single capability's own tables a foreign key is available and is simply not used here — worth
 * revisiting per table rather than as a rule.
 *
 * Referential integrity is held by the writers here, and deleting an organization deletes its children
 * first. `user_id` is the case the boundary rule is about: it names `pithy_auth_users`, which belongs to
 * `@pithy-sh/auth`.
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

    // "What is outstanding for this account" — the roster of offers, and the lookup a resend names.
    await db.schema
      .createIndex("pithyOrganizationInvitationsOrgStatusIdx")
      .on("pithyOrganizationInvitations")
      .columns(["organizationId", "status", "email"])
      .execute();

    /*
      **One live offer per address, as a constraint rather than as care in a handler.**

      `invite()` supersedes a standing offer and mints the new one in a single `d1.batch`, so that path is
      atomic on its own. This is the backstop underneath it: a property of the table, so it holds for a
      writer that never came through there — a bulk invite, an admin tool, a repair script. Two live
      tokens for one mailbox would make withdrawing the one a pane happens to show a revoke that does not
      revoke, because whichever copy the recipient kept still works for the rest of its TTL.

      Partial, on `status = 'pending'`, because the whole point is that spent and withdrawn offers
      accumulate as history — a plain unique index would refuse the second invitation anybody ever sent to
      an address, which is a legitimate act.

      **This was raw SQL, on the stated grounds that Kysely has no partial-index builder. It has one** —
      `CreateIndexBuilder.where`, whose own documentation says it "effectively turns the index partial" —
      and the claim was wrong when it was written. Going through the builder means `CamelCasePlugin`
      renders the identifiers, so the names here are camelCase like every other index in this file rather
      than the one snake_case string somebody had to remember to keep in step with the columns.

      Kysely's doc for `where` names PostgreSQL and MS SQL Server; SQLite supports partial indexes too and
      the SQLite compiler emits the clause. `migrations.workers.test.ts` asserts this index exists by name
      and `invite/invite.workers.test.ts` asserts what its partial-ness buys — a second offer to an
      address whose first was canceled — so both halves are held by a test rather than by that sentence.
    */
    await db.schema
      .createIndex("pithyOrganizationInvitationsOneLiveIdx")
      .unique()
      .on("pithyOrganizationInvitations")
      .columns(["organizationId", "email"])
      // `sql.ref`, not the plain string. `CreateIndexBuilder` narrows its column type from `.columns()`,
      // so a bare `"status"` is refused as "not one of the indexed columns" — which is a limitation of
      // the type rather than of partial indexes, since the whole point is to filter on a column that is
      // not in the key. The documented overload takes an expression, and the emitted SQL is identical.
      .where(sql.ref("status"), "=", "pending")
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
    /*
      **Every index this migration creates is dropped, in reverse.**

      SQLite takes an index with the table it is on, so the six below are redundant against the five
      drops that follow — and they are here anyway, because every other capability in this kit writes its
      `down` as the inverse of its `up`, index for index. `@pithy-sh/auth`, `@pithy-sh/audit`,
      `@pithy-sh/payments`, `@pithy-sh/support` and nine more all do; this file and `@pithy-sh/secrets`
      were the two that did not, which made them look considered rather than overlooked.

      Redundancy is also the cheaper side to be wrong on. The day a `down` here stops dropping a table —
      a column moved to its own table, a drop reordered — an index left behind is a name that collides on
      the next `up`, and `up after down is clean` is the test that would have to catch it. This makes it
      not arise.
    */
    await db.schema.dropIndex("pithyOrganizationActingOrgIdx").ifExists().execute();
    await db.schema.dropIndex("pithyOrganizationOwnershipNominationsMembershipIdx").ifExists().execute();
    await db.schema.dropIndex("pithyOrganizationInvitationsOneLiveIdx").ifExists().execute();
    await db.schema.dropIndex("pithyOrganizationInvitationsOrgStatusIdx").ifExists().execute();
    await db.schema.dropIndex("pithyOrganizationMembershipsOrgRoleIdx").ifExists().execute();
    await db.schema.dropIndex("pithyOrganizationMembershipsUserIdx").ifExists().execute();

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
