// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_organization_memberships` table — the join that puts a person inside an organization.
 *
 * **Membership is the authority, and nothing else is.** Not a claim on a session, not a cached role,
 * not the id in a URL. Every route that acts inside an organization re-reads this table, which is what
 * makes removing a row the whole of revocation: it takes effect on the next request, with no sign-out
 * and no cache to expire.
 *
 * ## Why `role` is a bounded string here and an enum everywhere else
 *
 * The role set is the **adopter's**, declared through `defineRoles` in their own project, so this
 * schema cannot name its members — it is compiled into the kit before any catalog exists. So the column
 * is text, and the catalog decodes it on the way out: `catalog.Role.parse(row.role)`.
 *
 * **That is the safer arrangement anyway, and it is the one the dashboard already ran.** A role that
 * matches no branch in a power matrix would deny everything today and, one refactor later, allow it. A
 * decode refuses it outright, at the boundary, where there is still a request to refuse.
 */

/** Bounded because it is a column, a log field and an audit value, and unbounded text is none of those. */
export const MAX_ROLE_LENGTH = 64;

export const Membership = z
  .object({
    id: z
      .uuid()
      .describe(
        "Primary key. A random UUID text id, and enforced as one — it is a path parameter on every route that acts on a membership, and those validate `z.uuid()`. The pair (organizationId, userId) is unique, so there is one row per person per organization; the surrogate key keeps the membership addressable by a single id when a role changes or access is revoked.",
      ),
    organizationId: z
      .uuid()
      .describe(
        "The organization this membership grants access to. Foreign key to `pithy_organization_organizations(id)`. Indexed.",
      ),
    // `pithy_auth_users` belongs to @pithy-sh/auth, a capability this one composes. It is never
    // redefined here and a user's columns are never read through this table: the id is a plain text
    // reference across a capability boundary.
    userId: z
      .string()
      .min(1)
      .describe(
        "The person this membership belongs to. References `pithy_auth_users(id)`, owned by the composed @pithy-sh/auth capability rather than by this one. Indexed, because listing a person's organizations starts here.",
      ),
    role: z
      .string()
      .min(1)
      .max(MAX_ROLE_LENGTH)
      .describe(
        "What this person may do here, as a name from the project's own `defineRoles` catalog. Text at the column because the catalog is the adopter's and is not known when this schema compiles; decoded through `catalog.Role` on every read, so a value the catalog does not know refuses rather than falling through the matrix. Never inferred from a session claim.",
      ),
    createdAt: SQLiteDate.describe(
      "When the person joined the organization. Ms-epoch in SQLite; a `Date` in app code.",
    ),
  })
  .describe(
    "One person's place in one organization, in `pithy_organization_memberships`. The authority every gate reads, so deleting a row is the whole of revocation.",
  );
export type Membership = z.output<typeof Membership>;
export type MembershipRow = z.input<typeof Membership>;
