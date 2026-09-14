// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InvitationStatus } from "../data/invitation";

/**
 * What the tenancy routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a client is crossing a trust boundary when it reads a Worker it
 * did not build, its own rules require it to validate the response before rendering it, and a
 * TypeScript interface is erased before it can help. Every client that had only an interface hand-wrote
 * a mirror of these, and the mirror drifted the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets a test compare a parsed value with a
 * projection's output and fail on a field either side forgot. A `SQLiteDate` here would decode an ISO
 * string into a `Date` and make that comparison meaningless.
 *
 * The projections that fill these live in `views.ts`, which documents *why* each field is here or
 * absent. This file is the shape; that file is the argument.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** This module is read across a
 * version boundary, so an additive required key fails `safeParse` for every client below that release
 * and takes the whole screen with it. Absent then means *this Worker cannot say*, which is a different
 * fact from `null`.
 *
 * ## What is never in this file
 *
 * **No token and no digest.** `Invitation.tokenDigest` is the row's whole credential story and
 * {@link InvitationView} has neither it nor the plaintext; the one place a token leaves the Worker is
 * {@link InviteResponse.acceptUrl}, and only for a project that turned the mail off and has to deliver
 * the link itself.
 *
 * **No role matrix.** A response says what one person's role *is*, never what it may do. The matrix is
 * the adopter's module, the client imports it directly, and a copy on the wire would be a second
 * authorization vocabulary free to disagree with the one the gates read.
 */

/**
 * A member's or an organization's mark, as a screen should draw it.
 *
 * A URL for a raster, the stored `data:` value itself for a vector, and null for nothing — whichever it
 * is, the caller renders it through the same `<img src>`. The split is the security answer rather than
 * a convenience: a vector fetched by navigation runs script in the origin that served it, so a vector
 * never gets a URL and the serving route refuses one even if asked.
 */
const MarkSource = z
  .string()
  .nullable()
  .describe(
    "Where to draw the mark from: a versioned URL for a raster, the stored `data:` value for a vector, or null when there is none — and then a caller draws initials, which is a real answer rather than a placeholder.",
  );

/** One organization, as somebody inside it sees it. */
export const OrganizationView = z
  .object({
    id: z.uuid().describe("The organization's id. What `POST {base}/acting` takes back."),
    name: z.string().describe("The display name."),
    slug: z.string().describe("The URL-safe short name. For display and for logs; nothing is addressed by it."),
    mark: MarkSource,
    role: z
      .string()
      .describe(
        "What the reader may do here, as a name from this project's catalog. A name, never a power list — the matrix is the adopter's module and the client imports it.",
      ),
    createdAt: z.iso.datetime().describe("When the organization was created, ISO-8601."),
  })
  .describe("One organization and the reader's standing in it. Never another person's standing.");
export type OrganizationView = z.output<typeof OrganizationView>;

/** `GET {base}/` — the chooser's data. */
export const OrganizationsResponse = z
  .object({
    organizations: z
      .array(OrganizationView)
      .describe("Every organization the caller may act in, by name. Empty is a real state, not an error."),
    acting: z
      .uuid()
      .nullable()
      .describe(
        "Which one is in force for this session, or null when nothing has been selected. The chooser's whole input.",
      ),
    chosen: z
      .boolean()
      .describe(
        "Whether somebody picked what is in force, as against being put into the only account they have. False with a non-null `acting` is what an account switcher keys on; a single `activeOrganizationId` column cannot carry this.",
      ),
  })
  .describe("What the caller may act in, and what they are acting in. The one route here that spans organizations.");
export type OrganizationsResponse = z.output<typeof OrganizationsResponse>;

/** `POST {base}/acting` — what is in force now. */
export const ActingResponse = z
  .object({
    organizationId: z.uuid().describe("The organization now in force for this session."),
    name: z.string().describe("Its display name, so a header re-reads from the answer rather than from what was sent."),
    slug: z.string().describe("Its short name."),
    role: z.string().describe("The caller's role in it, read off the membership rather than from the request."),
    chosen: z.boolean().describe("True — somebody picked this. The field exists so the chooser can stop asking."),
  })
  .describe("The organization this session acts in, read back from the row the choice wrote.");
export type ActingResponse = z.output<typeof ActingResponse>;

/** `GET {base}/current` — the acting organization as a record of itself. */
export const OrganizationRecordResponse = z
  .object({
    organization: OrganizationView.describe("The organization in force."),
    totals: z
      .object({
        members: z.number().int().min(0).describe("How many people are in the account."),
        invitations: z
          .number()
          .int()
          .min(0)
          .nullable()
          .describe(
            "How many offers are outstanding, or null for a reader who does not manage the account. Null rather than zero, because zero would be this record answering a question it declined to read — who has been asked and has not answered is of no use to somebody who cannot withdraw or resend one.",
          ),
      })
      .describe("What the account holds. Counts, not lists — the lists are their own routes with their own gates."),
  })
  .describe("The acting organization, as a record whose subject is the account itself.");
export type OrganizationRecordResponse = z.output<typeof OrganizationRecordResponse>;

/**
 * `POST {base}/` and `PATCH {base}/current` — the account as it now stands.
 *
 * The same shape for founding one and for changing one, because both answer the same question: what
 * does this organization look like now. Neither carries totals — a founder's account has one member and
 * no offers, and a rename changed neither, so counting would be two queries spent to report what the
 * caller already had.
 */
export const OrganizationResponse = z
  .object({ organization: OrganizationView.describe("The organization, with the caller's own standing in it.") })
  .describe("One organization, as a write reports it back.");
export type OrganizationResponse = z.output<typeof OrganizationResponse>;

/**
 * One person on the roster.
 *
 * **The address is here, and it is the opposite rule from the audit trail.** A roster names people by
 * address because that is what somebody matches against an invitation they sent — a live projection to
 * a co-member, discarded with the response. The audit trail refuses addresses because it is
 * append-only and nobody prunes it.
 *
 * `name` and `email` are null together when the membership outlived the user row. The roster says so
 * rather than rendering a blank where a person's name goes.
 */
export const MemberView = z
  .object({
    membershipId: z.uuid().describe("The membership's id — what a role change, a removal and a mark URL all name."),
    userId: z
      .string()
      .describe(
        "The person, as `pithy_auth_users` ids them. Never a UUID shape: that generator is the auth capability's and is configurable.",
      ),
    role: z.string().describe("What they may do here."),
    name: z.string().nullable().describe("Their display name, or null when the user row is gone."),
    email: z.string().nullable().describe("Their address, or null when the user row is gone."),
    mark: MarkSource,
    joinedAt: z.iso.datetime().describe("When they joined the organization, ISO-8601."),
  })
  .describe("One member of the acting organization, resolved through the auth capability's own accessor.");
export type MemberView = z.output<typeof MemberView>;

/** `GET {base}/current/members` — the roster. */
export const MembersResponse = z
  .object({ members: z.array(MemberView).describe("Everybody in the acting organization, oldest membership first.") })
  .describe("Who is in the account in force.");
export type MembersResponse = z.output<typeof MembersResponse>;

/** A membership after it was written — the minimum a caller needs to re-render one row. */
export const MembershipView = z
  .object({
    membershipId: z.uuid().describe("The membership."),
    userId: z.string().describe("The person it belongs to."),
    role: z.string().describe("What they may do here, as the write left it."),
  })
  .describe("One membership, as a write reports it back.");
export type MembershipView = z.output<typeof MembershipView>;

/** `PATCH {base}/current/members/:membershipId` — the role as it now stands. */
export const MemberRoleResponse = z
  .object({ member: MembershipView.describe("The membership, with its new role.") })
  .describe("What a role change left behind.");
export type MemberRoleResponse = z.output<typeof MemberRoleResponse>;

/**
 * `DELETE {base}/current/members/:membershipId` and `POST {base}/current/members/leave`.
 *
 * `left` is why one response serves both: a removal and a leaving end the same row and are different
 * acts, audited under different codes, and a client that wants to say "you have left Acme" rather than
 * "Acme removed you" needs to be told which happened.
 */
export const RemovedMemberResponse = z
  .object({
    membershipId: z.uuid().describe("The membership that ended."),
    left: z.boolean().describe("True when the person removed themselves. False when somebody else removed them."),
  })
  .describe("Which membership ended, and whose decision it was.");
export type RemovedMemberResponse = z.output<typeof RemovedMemberResponse>;

/** `DELETE {base}/current` — the account is gone. */
export const DeletedOrganizationResponse = z
  .object({
    organizationId: z
      .uuid()
      .describe(
        "The organization that was deleted, with every membership, invitation and selection of it. Echoed so a client can clear exactly what it held rather than guessing from its own state.",
      ),
  })
  .describe("What the heaviest act in the capability left behind.");
export type DeletedOrganizationResponse = z.output<typeof DeletedOrganizationResponse>;

/**
 * One outstanding offer.
 *
 * **Neither the token nor its digest.** The plaintext exists in the mail and nowhere else; the digest is
 * what the row is filed under, and a response carrying it would put a matchable value for a live
 * credential on the wire. Withdrawing and resending name the offer by {@link InvitationView.id}.
 */
export const InvitationView = z
  .object({
    id: z.uuid().describe("The offer's id — what a withdrawal names."),
    email: z.string().describe("The address invited. The binding that makes a forwarded link useless."),
    role: z
      .string()
      .describe(
        "What is being offered. Written onto the membership at acceptance, never re-read from the request that accepts.",
      ),
    invitedByUserId: z
      .string()
      .describe("Who sent it. An invitation with no author would be a membership nobody answers for."),
    status: InvitationStatus.describe("Where the offer stands. `pending` is the only redeemable state."),
    expiresAt: z.iso
      .datetime()
      .describe(
        "When the link stops working, ISO-8601. Compared against now on every redemption, so an unswept row is still refused.",
      ),
    createdAt: z.iso
      .datetime()
      .describe(
        "When it was sent, ISO-8601. A resend moves this, because a resent invitation is a new offer with a new life.",
      ),
  })
  .describe("One offer of membership, as somebody who manages the account sees it. Never the token.");
export type InvitationView = z.output<typeof InvitationView>;

/** `GET {base}/current/invitations` — what is outstanding. */
export const InvitationsResponse = z
  .object({
    invitations: z
      .array(InvitationView)
      .describe(
        "What is outstanding, newest first — `pending` only, expired ones included, because an expired offer is the answer to 'why has that person not appeared' and the input to the resend that fixes it.",
      ),
  })
  .describe("The account's invitations.");
export type InvitationsResponse = z.output<typeof InvitationsResponse>;

/** `POST {base}/current/invitations` — the offer that was just written. */
export const InviteResponse = z
  .object({
    invitation: InvitationView.describe("The offer."),
    acceptUrl: z
      .string()
      .nullable()
      .describe(
        "The link, **only** for a project that set `sendInvitationEmail: false` and delivers it itself. Null when the capability mailed it — the token is then in the mail and in no response, which is the whole point of putting it there.",
      ),
  })
  .describe("What inviting somebody wrote, and the link when nobody else is going to send it.");
export type InviteResponse = z.output<typeof InviteResponse>;

/** `DELETE {base}/current/invitations/:invitationId` — the offer as the withdrawal left it. */
export const WithdrawnInvitationResponse = z
  .object({
    invitation: InvitationView.describe(
      "The offer, now `canceled`. Returned rather than an empty body because a withdrawal is a state change on a row a client is already rendering, and re-reading a list to learn the outcome of a write is how a pane shows a stale one.",
    ),
  })
  .describe("What withdrawing an offer left behind.");
export type WithdrawnInvitationResponse = z.output<typeof WithdrawnInvitationResponse>;

/**
 * `GET {base}/invitations/:token` — the three facts an accept screen renders.
 *
 * **Deliberately not an {@link InvitationView}.** This is the one response in the file a caller reaches
 * with no session and no membership, holding only a token, so it says the least that still lets
 * somebody decide: which account, who asked, and what they would become. No id, no address, no status,
 * no sender's user id — a forwarded link must not become a read of the account's own records, and every
 * one of those fields is on the route behind `organization:manage` for somebody who is already inside.
 */
export const InvitationOfferResponse = z
  .object({
    organizationName: z.string().describe("The account being joined, by display name. Tenant text; escape it."),
    inviterName: z
      .string()
      .nullable()
      .describe("What the sender calls themselves, or null when the user row is gone. Tenant text too."),
    role: z.string().describe("What the offer confers, as a name from this project's catalog."),
    expiresAt: z.iso.datetime().describe("When the link stops working, ISO-8601."),
  })
  .describe("What an accept screen shows somebody holding an invitation link, and nothing more.");
export type InvitationOfferResponse = z.output<typeof InvitationOfferResponse>;

/** `POST {base}/invitations/accept` — what redeeming one did. */
export const AcceptInvitationResponse = z
  .object({
    organizationId: z.uuid().describe("The organization joined."),
    membershipId: z.uuid().describe("The membership, new or the one already held."),
    role: z.string().describe("What was granted — the role the offer carried, never one the request named."),
    joined: z
      .boolean()
      .describe(
        "False when the person was already a member. The offer is consumed either way, so redeeming twice is idempotent rather than an error a client has to tell from a refusal.",
      ),
  })
  .describe(
    "The membership an accepted offer produced. Does not move the acting organization: joining and looking are two acts.",
  );
export type AcceptInvitationResponse = z.output<typeof AcceptInvitationResponse>;

/** One standing offer of ownership. */
export const NominationView = z
  .object({
    membershipId: z.uuid().describe("The nominee's membership."),
    nominatedByUserId: z.string().describe("Who made the offer. The nominee's screen names them."),
    expiresAt: z.iso.datetime().describe("When the offer stops being acceptable, ISO-8601."),
    createdAt: z.iso.datetime().describe("When it was made, ISO-8601."),
  })
  .describe("The account's one standing offer of ownership. One per organization, enforced by the table.");
export type NominationView = z.output<typeof NominationView>;

/** `GET {base}/current/ownership`, `POST {base}/current/ownership` and `DELETE {base}/current/ownership`. */
export const NominationResponse = z
  .object({
    nomination: NominationView.nullable().describe("The offer that now stands, or null after a withdrawal."),
  })
  .describe("Where the account's ownership offer stands.");
export type NominationResponse = z.output<typeof NominationResponse>;

/** `POST {base}/ownership/accept` — both sides of a transfer. */
export const TransferResponse = z
  .object({
    newHolderMembershipId: z.uuid().describe("Who holds it now."),
    previousHolderMembershipIds: z
      .array(z.uuid())
      .describe(
        "Who stopped holding it in the same write — plural, because nothing in the schema guarantees there was exactly one, and a response that promised a single id would be wrong on the day a deployment found two.",
      ),
  })
  .describe("A transfer of ownership: somebody stopped holding it in the same write somebody else started.");
export type TransferResponse = z.output<typeof TransferResponse>;

/**
 * ## The management surface, below
 *
 * Everything above answers a member's session. Everything below answers a control-plane credential the
 * adopter issued, and it is **read-only**: every mutation this capability ships is an administrative act
 * inside one account, audited against the membership that took it, and a management caller holds no
 * membership by design. `scopes.ts` argues it at length.
 *
 * Both listings are **bounded and say so**, rather than paged. A management client walking a tenant list
 * wants the first hundred and a truthful flag; a cursor would be machinery for a surface whose whole job
 * is telling an operator which account to look at.
 */

/** One tenant, as a management client sees it. No addresses — that is the other scope. */
export const AdminOrganizationView = z
  .object({
    id: z.uuid().describe("The organization's id."),
    name: z.string().describe("The display name."),
    slug: z.string().describe("The URL-safe short name."),
    members: z.number().int().min(0).describe("How many people are in the account."),
    createdAt: z.iso.datetime().describe("When the organization was created, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When its row was last written, ISO-8601."),
  })
  .describe(
    "One tenant as a management client sees it. No mark and no addresses: the mark is served from a session-authorized route a management client cannot call, and the people are the other scope.",
  );
export type AdminOrganizationView = z.output<typeof AdminOrganizationView>;

/** `GET {base}/admin/organizations`. */
export const AdminOrganizationsResponse = z
  .object({
    organizations: z.array(AdminOrganizationView).describe("The tenants, newest first."),
    truncated: z
      .boolean()
      .describe(
        "True when more accounts exist than the bound allowed. A client must say so rather than imply a total.",
      ),
  })
  .describe("The tenant list, bounded, with an honest flag where it was cut short.");
export type AdminOrganizationsResponse = z.output<typeof AdminOrganizationsResponse>;

/**
 * One member, as a management client sees them.
 *
 * The address is here and it is the point of the scope: an operator answering "who is in this account,
 * and is this the person who wrote in" needs it. It is also why this is a second scope rather than a
 * field on the first.
 */
export const AdminMemberView = z
  .object({
    membershipId: z.uuid().describe("The membership's id."),
    userId: z.string().describe("The person, as `pithy_auth_users` ids them."),
    role: z.string().describe("What they may do in this account."),
    name: z.string().nullable().describe("Their display name, or null when the user row is gone."),
    email: z.string().nullable().describe("Their address, or null when the user row is gone."),
    joinedAt: z.iso.datetime().describe("When they joined, ISO-8601."),
  })
  .describe("One member of one tenant, as a management client sees them.");
export type AdminMemberView = z.output<typeof AdminMemberView>;

/** `GET {base}/admin/organizations/:organizationId/members`. */
export const AdminMembersResponse = z
  .object({
    members: z.array(AdminMemberView).describe("The roster, oldest membership first."),
    truncated: z.boolean().describe("True when more members exist than the bound allowed."),
  })
  .describe("One tenant's roster, bounded, with an honest flag where it was cut short.");
export type AdminMembersResponse = z.output<typeof AdminMembersResponse>;
