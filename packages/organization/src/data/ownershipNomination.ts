// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_organization_ownership_nominations` table — one standing offer of ownership per
 * organization.
 *
 * **Ownership transfer is two-party, and this row is the gap between the two parties.** Somebody who
 * may offer it nominates; the nominee accepts; the previous holder is demoted in the same write. Nobody
 * is made responsible for an account by somebody else's click, which is the whole reason a nomination
 * is a row rather than an `UPDATE memberships SET role`.
 *
 * **The organization is the primary key, so there is exactly one nomination at a time.** That is the
 * rule expressed as a constraint rather than as care in a handler: two live nominations would make "who
 * did the account offer itself to" a question with two answers, and the second acceptance would be
 * racing the first for a role only one person can hold. Nominating again replaces — the write is a
 * conflict-update — so changing your mind is one act rather than a withdrawal and a re-offer with a
 * window between them.
 *
 * **The nominee is named by membership, not by user.** A nomination is an offer to somebody already
 * inside the account, and the row goes when the membership does — rather than sitting there waiting for
 * somebody who can no longer see the organization to accept it.
 *
 * **It expires.** An offer to take an account on is a live grant, and a live grant with no end date is
 * one somebody accepts a year later having forgotten it was made.
 *
 * There is no token and no mail here, and that is the difference from `./invitation.ts`. An invitee is a
 * stranger to the account and has to prove they hold an address; a nominee already holds a session this
 * account trusts, so acceptance is an act taken *inside* the product by a person the organization can
 * already see. A token would add a credential to steal for no authorization it buys.
 */
export const OwnershipNomination = z
  .object({
    organizationId: z
      .uuid()
      .describe(
        "The organization whose ownership is being offered, and the primary key — one nomination per account, enforced by the table rather than by whoever writes it. Foreign key to `pithy_organization_organizations(id)`.",
      ),
    membershipId: z
      .uuid()
      .describe(
        "The nominee's membership, not their user id. References `pithy_organization_memberships(id)` — a person removed from the account takes any offer made to them with them, so no offer can be accepted by somebody who is no longer inside.",
      ),
    nominatedByUserId: z
      .string()
      .min(1)
      .describe(
        "Who made the offer, from `pithy_auth_users`. Kept because the transfer is audited against it, and because the nominee's screen names who asked.",
      ),
    expiresAt: SQLiteDate.describe(
      "When the offer stops being acceptable. An open-ended offer of somebody else's account is a grant that outlives every reason it was made.",
    ),
    createdAt: SQLiteDate.describe("When the nomination was made. Ms-epoch in SQLite; a `Date` in app code."),
  })
  .describe(
    "One standing offer of ownership, in `pithy_organization_ownership_nominations`. One row per organization, keyed by it, so an account offers itself to at most one person at a time — and the offer dies with the membership it was made to.",
  );
export type OwnershipNomination = z.output<typeof OwnershipNomination>;
export type OwnershipNominationRow = z.input<typeof OwnershipNomination>;
