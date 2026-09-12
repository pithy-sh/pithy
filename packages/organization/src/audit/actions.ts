// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Every administrative act this capability can take, as an audit action code.
 *
 * **A membership is transitively a credential to whatever the tenant owns.** Adding one, changing what
 * it may do, and taking it away are the three acts that decide who can reach a customer's data, and the
 * question somebody asks a fortnight later is always the same: *who did that, and when*. These codes
 * are what make it a question with an answer.
 *
 * Emitted through core's `emit()` seam (`c.var.emit`), never by importing `@pithy-sh/audit` — the seam
 * is always present (`noopEmit` when no audit capability is composed), so there is no null check and no
 * hard dependency. `./emit.ts` is the only writer.
 *
 * ## The register is closed, and each code is one event rather than one outcome
 *
 * `invitation_revoked` and `member_left` are not folded into their neighbors. Withdrawing an offer is
 * the organization's act; leaving is the member's; being removed is somebody else's. A register that
 * merged them would answer "why is this person not in the account" with a shrug, which is exactly the
 * question a removal makes somebody want to read.
 *
 * Expiry is deliberately absent. An invitation expires by its `expiresAt` passing, which is not an act
 * anybody took — there is no actor to attribute it to, and a row saying nobody did nothing at 3am is
 * noise in a trail read under pressure.
 *
 * ## No row ever carries personal data
 *
 * These events are *about* email addresses, which is the obvious way a copy of one lands in an
 * append-only table nobody prunes. So the resource is the invitation's or the membership's id — a
 * pointer, ours, meaningless outside this database — and `./emit.ts` refuses anything address-shaped on
 * the way past. The trail answers "who was invited" by naming the invitation, which a roster resolves
 * for anyone entitled to see it; the trail itself never becomes a directory of who an adopter has
 * mailed.
 *
 * ## A code is stable forever once a row holds one
 *
 * The same rule as a role name, for the same reason: a renamed code orphans every event already written
 * under the old one, and nothing here can repair that. Add; never rename.
 */
export const OrganizationAuditActions = {
  /**
   * An organization was created, and its founder became its first administrator.
   *
   * The first event in any account's history, and the only one whose actor was not yet a member of
   * anything when they took it. It writes a membership row — an administrative act by the definition
   * every other code here is held to — so an account whose trail began at its second event could never
   * answer who brought it into being.
   */
  created: "organization/created",
  /** The display name changed. The slug never does, so this is the whole of a rename. */
  renamed: "organization/renamed",
  /**
   * The account's mark was set, replaced, or taken off.
   *
   * Audited because the mark is what a member recognizes an account by, in the chooser and in every
   * invitation mail sent on its behalf — swapping it for another company's is a cheap way to make an
   * invitation look like it came from somewhere else.
   */
  logoChanged: "organization/logo_changed",
  /**
   * The organization was deleted, and every membership, invitation and selection with it.
   *
   * The heaviest act in the capability and the one with no undo. Recorded against the account that no
   * longer exists, which is the only record that it ever did.
   */
  deleted: "organization/deleted",
  /** Somebody was invited. An offer to an address, not yet a membership. */
  memberInvited: "organization/member_invited",
  /** An invitation was sent again, which mints a new token and kills the old one. */
  invitationResent: "organization/invitation_resent",
  /** An outstanding invitation was withdrawn by the organization. Nobody joined. */
  invitationRevoked: "organization/invitation_revoked",
  /** An invitation was accepted and a membership was created. The one event that grants access. */
  memberJoined: "organization/member_joined",
  /** A member's role changed — the whole of what they may do here. */
  memberRoleChanged: "organization/member_role_changed",
  /** A member was removed by somebody else. */
  memberRemoved: "organization/member_removed",
  /** A member removed themselves. Distinct from being removed: a different person decided. */
  memberLeft: "organization/member_left",
  /** Ownership was offered to a member. An offer, not a transfer — nothing has moved yet. */
  ownershipNominated: "organization/ownership_nominated",
  /** An offer of ownership was withdrawn before anybody accepted it. */
  ownershipWithdrawn: "organization/ownership_withdrawn",
  /** A nominee accepted, so the account and its bill changed hands. The heaviest membership event. */
  ownershipAccepted: "organization/ownership_accepted",
} as const;

/** One of this capability's audit actions. */
export type OrganizationAuditAction = (typeof OrganizationAuditActions)[keyof typeof OrganizationAuditActions];

/**
 * The domain every code above sits in.
 *
 * Named rather than spelled at each assertion, because the one property that makes this register
 * federatable — core's taxonomy is open, and each capability owns a namespace — is that nothing here
 * writes outside it.
 */
export const ORGANIZATION_AUDIT_DOMAIN = "organization";
