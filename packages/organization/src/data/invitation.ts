// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_ADDRESS_LENGTH } from "@pithy-sh/core/src/address/address";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MAX_ROLE_LENGTH } from "./membership";

/**
 * The `pithy_organization_invitations` table — the only way a membership comes into existence besides
 * founding one.
 *
 * A membership reaches whatever the organization owns, so the act that creates one is not a form
 * somebody fills in about another person — it is an **offer to an address**, accepted by whoever proves
 * they hold that address. This table is that offer.
 *
 * **Bound to an email, and that is the security property.** The token alone is not sufficient: the
 * accepting session's own address has to equal {@link Invitation.email}. An invitation any holder of
 * the link could redeem is a membership grant to a forwarded mailbox, a shared inbox, a screenshot in
 * a group chat — and the person who ends up inside the account is then somebody nobody chose. The mail
 * carries the token; the address is what makes the token mean one person.
 *
 * **The token is stored as a digest.** A database read — a backup, a dumped row, a query somebody ran
 * in support — must never yield a live credential. The plaintext exists in the mail and nowhere else,
 * so losing this table loses nobody's invitation *and* hands nobody one.
 *
 * **Single use is the status column, not a flag and not a delete.** Acceptance is a conditional update
 * on `status`, so of N concurrent redemptions exactly one row-change wins and exactly one membership is
 * created. A row deleted on acceptance would make "was this accepted, and by whom" unanswerable a week
 * later; a boolean would make withdrawn and expired the same fact.
 */

/**
 * Where an invitation stands. Four answers, and each is a different event.
 *
 * `rejected` and `canceled` are not merged: one is the invitee declining, the other is the organization
 * withdrawing. A single `dead` state would answer "why is this person not in the account" with a shrug,
 * which is exactly the question somebody asks a fortnight later.
 *
 * Expiry is deliberately **not** a state. It is `expiresAt` compared against now, so a row does not need
 * a sweep to become untrue and an unswept row cannot be redeemed after its date.
 */
export const InvitationStatus = z
  .enum(["pending", "accepted", "rejected", "canceled"])
  .describe(
    "Where an invitation stands. `pending` is the only redeemable state; acceptance moves it under a condition, so single use is a property of the write rather than an intention of the caller.",
  );
export type InvitationStatus = z.output<typeof InvitationStatus>;

export const Invitation = z
  .object({
    id: z
      .uuid()
      .describe(
        "The row id. A UUID, because withdrawing and resending name an invitation in the API — and because an enumerable id would let a member of one organization count another's pending invitations.",
      ),
    organizationId: z
      .uuid()
      .describe(
        "The organization being joined. Foreign key to `pithy_organization_organizations(id)` — an account that is deleted takes its outstanding offers with it, because a link that outlived its organization would resolve to nothing at the moment somebody clicked it.",
      ),
    email: z
      .string()
      .min(3)
      .max(MAX_ADDRESS_LENGTH)
      .describe(
        "The address invited, normalized through `@pithy-sh/core`'s `normalizeAddress` before it is written. Stored rather than hashed because acceptance compares it against the accepting session's own address, and because somebody has to be able to see who they invited.",
      ),
    role: z
      .string()
      .min(1)
      .max(MAX_ROLE_LENGTH)
      .describe(
        "What the invitation offers, as a name from the project's `defineRoles` catalog — and only ever an assignable one, checked on the write. Written onto the membership at acceptance and never re-read from the request that accepts, so what was offered is what is granted.",
      ),
    invitedByUserId: z
      .string()
      .min(1)
      .describe(
        "Who sent it, from `pithy_auth_users`. The accept screen names them, and the audit trail attributes the grant — an invitation with no author would be a membership nobody answers for.",
      ),
    tokenDigest: z
      .string()
      .min(1)
      .describe(
        "SHA-256 of the invitation token, base64url. The token itself is never stored: a read of this table must not yield something that can be redeemed. Acceptance hashes what it was given and matches on this.",
      ),
    status: InvitationStatus.describe(
      "Where this offer stands. Moved by conditional update, which is what makes acceptance single-use rather than merely intended.",
    ),
    expiresAt: SQLiteDate.describe(
      "When the link stops working. Days rather than hours, deliberately: somebody invited on a Friday should not find a dead link on Monday. Compared against now on every redemption, so an unswept row is still refused.",
    ),
    acceptedAt: SQLiteDate.nullable().describe(
      "When it was accepted, or null while it has not been. Recorded separately from `status` because the date is what ties a membership to the offer that created it.",
    ),
    createdAt: SQLiteDate.describe(
      "When the invitation was sent. Resending replaces the token and moves this, because a resent invitation is a new offer with a new life.",
    ),
  })
  .describe(
    "One outstanding offer of membership, in `pithy_organization_invitations`. Bound to an address, carried by a token held only as a digest, redeemable once by conditional update, and expiring on its own.",
  );
export type Invitation = z.output<typeof Invitation>;
export type InvitationRow = z.input<typeof Invitation>;
