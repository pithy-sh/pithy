// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { User } from "@pithy-sh/auth/src/data/betterAuth";
import { userImageSource } from "@pithy-sh/auth/src/profile/profile";
import { storedImageSource } from "@pithy-sh/core/src/image/storedImage";
import type { ActingMembership } from "../acting/acting";
import type { Invitation } from "../data/invitation";
import type { Membership } from "../data/membership";
import type { Organization } from "../data/organization";
import type { OwnershipNomination } from "../data/ownershipNomination";
import { memberImagePath } from "../people/people";
import type {
  ActingResponse,
  AdminMemberView,
  AdminOrganizationView,
  InvitationOfferResponse,
  InvitationView,
  MembershipView,
  MemberView,
  NominationView,
  OrganizationView,
} from "./responses";

/**
 * The projections — what leaves the Worker for an organization, a member, an offer and a nomination.
 *
 * **No handler returns a row.** Each function below states what leaves, and each return type is
 * `z.output` of the matching object in `responses.ts`, so the shape a client validates against and the
 * shape this produces are one declaration. Adding a field to one and not the other does not compile.
 *
 * Separated from `routes.ts` so they can be exercised without a request, a session, or a membership: a
 * node test runs each against a fully populated row and compares the result with its schema. A leak
 * here is a leak on every screen, and it should not need a Workers pool to catch.
 *
 * ## What each of these deliberately drops
 *
 * **`Invitation.tokenDigest`.** It is what the row is filed under. A response carrying it would put a
 * matchable value for a live credential on the wire, and the offer is already addressable by its id.
 *
 * **A member's `locale` and `emailVerified`.** Both are the auth capability's facts about a person,
 * neither is a fact about their membership, and a roster is not a support pane. The address and the
 * name are here because matching a colleague against an invitation you sent is what a roster is for.
 *
 * **The role's powers, everywhere.** A view says what somebody's role *is*. What it may do is the
 * adopter's matrix, which their client imports directly — a copy on the wire would be a second
 * authorization vocabulary, free to disagree with the one the gates read.
 */

/** The path segment an organization's mark is served under. */
export const MARKS_SEGMENT = "/marks";

/**
 * Where an organization's mark is served.
 *
 * **Its own route, and not the one a member's face uses, because the two are told apart by their gate
 * rather than by their shape.** This one needs only a membership in the organization it names, and it
 * is drawn on the chooser — where no organization is in force yet, so there is nothing for an acting
 * selection to gate against. A member's face is the opposite: it is entitled by the acting organization
 * the roster was read in, and `people.ts` owns that path for exactly that reason. One route serving both
 * would have to spend the difference inside a handler that had already been let through.
 */
export function organizationMarkPath(basePath: string, organizationId: string): string {
  return `${basePath}${MARKS_SEGMENT}/organization/${encodeURIComponent(organizationId)}`;
}

/**
 * One organization, with the reader's own standing in it.
 *
 * `role` is the reader's, never the row's — a membership is one person's, and an organization has as
 * many answers to "what may you do here" as it has members. The caller is the one being answered.
 *
 * The mark goes through `storedImageSource`, so a raster becomes a versioned URL a browser caches and a
 * vector stays inline. The version is `updatedAt`, which moves whenever the mark can have changed — the
 * whole reason the served response may be `immutable`.
 */
export function organizationView(organization: Organization, role: string, basePath: string): OrganizationView {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    mark: storedImageSource(organization.logo, organizationMarkPath(basePath, organization.id), organization.updatedAt),
    role,
    createdAt: organization.createdAt.toISOString(),
  };
}

/**
 * What is in force, read back off the row the choice wrote.
 *
 * Not the id that was sent. A caller that re-renders from its own request is rendering what it asked
 * for rather than what happened, and the two differ exactly when something refused.
 */
export function actingView(acting: ActingMembership): ActingResponse {
  return {
    organizationId: acting.organizationId,
    name: acting.name,
    slug: acting.slug,
    role: acting.role,
    chosen: acting.chosen,
  };
}

/**
 * One member, resolved through the auth capability's own accessor rather than a join we wrote.
 *
 * `pithy_auth_users` belongs to that capability and its shape is its own; a hand-written join here
 * would be this package holding an opinion about a table it does not own, and would break on the day
 * that capability changes one.
 *
 * **A missing user is a real answer, not a gap to paper over.** `name` and `email` are null together
 * when the membership outlived the row, and the roster says so rather than rendering a blank where a
 * person's name goes.
 */
export function memberView(membership: Membership, user: User | undefined, basePath: string): MemberView {
  const name = user?.name?.trim();
  return {
    membershipId: membership.id,
    userId: membership.userId,
    role: membership.role,
    name: name === undefined || name === "" ? null : name,
    email: user?.email ?? null,
    // **Through `@pithy-sh/auth`'s own reader, not core's.** That column can hold a third shape this
    // capability's own cannot: a link to the provider somebody signed in with. `storedImageSource`
    // answers null for one, which would drop a Google avatar off every roster; `userImageSource` passes
    // it through, because it is the function that owns what that column may hold.
    //
    // Keyed by the membership, so the URL entitles through the roster it is drawn on, and versioned by
    // the user row's `updatedAt`, because that is what moves when the picture does.
    mark:
      user === undefined ? null : userImageSource(user.image, memberImagePath(basePath, membership.id), user.updatedAt),
    joinedAt: membership.createdAt.toISOString(),
  };
}

/** One membership as a write reports it back — the three fields a caller needs to re-render one row. */
export function membershipView(membership: { id: string; userId: string; role: string }): MembershipView {
  return { membershipId: membership.id, userId: membership.userId, role: membership.role };
}

/** One outstanding offer. The digest stays in the row and the token stays in the mail. */
export function invitationView(invitation: Invitation): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedByUserId: invitation.invitedByUserId,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  };
}

/**
 * What somebody holding an invitation link is shown before they accept.
 *
 * **Three facts and a date, and the omissions are the design.** The reader has proved nothing — they
 * hold a token, which is how this route is reached at all — so it says what a person needs in order to
 * decide, and stops. No invitation id, no invited address, no status, no sender's user id: a forwarded
 * link must not become a read of the account's own records, and every one of those is available a route
 * away to somebody who is already inside.
 *
 * The inviter's name is null when their user row is gone. The offer still stands — it was made, and the
 * role it carries is what acceptance grants — so the screen names the account and says nothing about
 * who asked, rather than refusing an invitation for a reason that is not the invitee's.
 */
export function invitationOfferView(
  invitation: Invitation,
  organizationName: string,
  inviter: User | undefined,
): InvitationOfferResponse {
  const name = inviter?.name?.trim();
  return {
    organizationName,
    inviterName: name === undefined || name === "" ? null : name,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

/** The account's one standing offer of ownership. */
export function nominationView(nomination: OwnershipNomination): NominationView {
  return {
    membershipId: nomination.membershipId,
    nominatedByUserId: nomination.nominatedByUserId,
    expiresAt: nomination.expiresAt.toISOString(),
    createdAt: nomination.createdAt.toISOString(),
  };
}

/**
 * One tenant, as a management client sees it.
 *
 * **No mark.** `storedImageSource` would mint a URL onto a route gated by membership, which a
 * management credential can never satisfy — so the field would be a link that 404s for the only caller
 * it was rendered for. The account list exists to say which tenant to look at, not to draw it.
 */
export function adminOrganizationView(organization: Organization, members: number): AdminOrganizationView {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    members,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

/** One member of one tenant, as a management client sees them. Same absent-user rule as the roster. */
export function adminMemberView(membership: Membership, user: User | undefined): AdminMemberView {
  const name = user?.name?.trim();
  return {
    membershipId: membership.id,
    userId: membership.userId,
    role: membership.role,
    name: name === undefined || name === "" ? null : name,
    email: user?.email ?? null,
    joinedAt: membership.createdAt.toISOString(),
  };
}
