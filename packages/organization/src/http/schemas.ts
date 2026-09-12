// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_ADDRESS_LENGTH } from "@pithy-sh/core/src/address/address";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { StoredImage } from "@pithy-sh/core/src/image/storedImage";
import { z } from "zod";
import { MAX_ROLE_LENGTH } from "../data/membership";
import { MAX_ORGANIZATION_NAME_LENGTH, Organization } from "../data/organization";

/**
 * What the tenancy routes accept, declared on the route line with
 * `zValidator(target, Schema, validationHook)` — so reading `routes.ts` says what each route takes
 * without opening a handler.
 *
 * ## Nothing here names an organization, except the two that must
 *
 * The acting organization is session state, so a scoped route has no field and no path segment that
 * could carry another tenant's id. {@link ChooseOrganization} is where a caller names one, and it is the
 * one write in the capability that turns a supplied id into a membership — refused with the same 404 as
 * a nonexistent account when it is not theirs. {@link OrganizationMarkParam} is the other, and it is a
 * read of a mark drawn on the chooser, where there is no acting organization yet.
 *
 * ## A role arrives as bounded text, never as the catalog's enum
 *
 * The catalog is the adopter's and is a value at compose time, not a type these modules can name. So a
 * request carries a bounded string and the **store** decodes it — `catalog.AssignableRole` in
 * `invite()` and `changeRole()`. Validating it here would mean either a schema built per catalog, which
 * puts the authorization vocabulary in two places, or a 400 where the honest answer is a 403 about who
 * may hand out that role.
 *
 * ## Ids are `z.uuid()`, and addresses are `z.email()`
 *
 * Every id this capability mints is a UUID — `Membership.id`, `Invitation.id`, `Organization.id` all
 * say so at the column — so the shape is a real bound rather than a guess, and a malformed one is a 400
 * before a query runs. A user id is the exception and never appears in a request here: it is
 * `@pithy-sh/auth`'s, its generator is configurable, and a UUID shape would 404 every project that
 * changed it.
 */

/** A role name, as a request carries it: bounded text, decoded against the catalog by the store. */
const RoleName = z
  .string()
  .min(1)
  .max(MAX_ROLE_LENGTH)
  .describe(
    "A role from this project's `defineRoles` catalog. Bounded text here rather than an enum, because the catalog is the adopter's and is a value at compose time; the store decodes it through `catalog.AssignableRole` and refuses an unassignable or unknown one with a 403.",
  );

/** The body of `POST {base}/` — found an organization. */
export const CreateOrganization = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_ORGANIZATION_NAME_LENGTH)
      .describe("The organization's display name, as it will appear on screen and in every invitation sent for it."),
    slug: Organization.shape.slug.describe(
      "The URL-safe short name, unique across all organizations. Lowercase alphanumerics and single hyphens, bounded — the column's own rule, read from it rather than restated, so a form and a column can never disagree about what a slug is.",
    ),
  })
  .describe("What founding an organization takes. The founder's role is the catalog's and is not in the request.");
export type CreateOrganization = z.output<typeof CreateOrganization>;

/**
 * The body of `POST {base}/acting` — which organization this session acts in.
 *
 * **By id, not by slug.** `GET {base}/` hands the caller ids, so a chooser echoes back what it was
 * given; a slug would make the choice addressable by a value people type, and a mistyped one would be
 * a refusal that reveals which short names are taken.
 */
export const ChooseOrganization = z
  .object({
    organizationId: z
      .uuid()
      .describe(
        "The organization to act in. Proved against a membership of the caller in one predicate before anything is written — an account they are not in refuses with the same 404 as one that does not exist.",
      ),
  })
  .describe("Which organization this session acts in from now on.");
export type ChooseOrganization = z.output<typeof ChooseOrganization>;

/**
 * The body of `PATCH {base}/current` — the name, the mark, or both.
 *
 * **Absent is *leave it*; `null` on the mark is *take it off*.** Two different instructions, and a
 * single nullable field could only carry one of them. At least one has to be present, because a body
 * saying nothing is a write nobody asked for.
 */
export const UpdateOrganization = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_ORGANIZATION_NAME_LENGTH)
      .optional()
      .describe("A new display name. Absent leaves the current one."),
    logo: StoredImage.nullable()
      .optional()
      .describe(
        "A new mark as a stored `data:` image under the kit's one image rule, `null` to take it off, or absent to leave it. Never a remote URL: a link to somebody else's host would mean fetching an attacker-chosen origin from a page listing tenancies.",
      ),
  })
  .refine((body) => body.name !== undefined || body.logo !== undefined, {
    message: "Name the field to change.",
    path: ["name"],
  })
  .describe("What changing an organization takes. At least one field, because an empty body is not a change.");
export type UpdateOrganization = z.output<typeof UpdateOrganization>;

/** The path parameters of every route that names a membership inside the acting organization. */
export const MembershipParam = z
  .object({
    membershipId: z
      .uuid()
      .describe(
        "The membership acted on. Resolved against the acting organization in one predicate, so an id belonging to another account is a 404 rather than a write.",
      ),
  })
  .describe("Which membership a role change or a removal names.");
export type MembershipParam = z.output<typeof MembershipParam>;

/** The path parameters of the route that withdraws one outstanding offer. */
export const InvitationParam = z
  .object({
    invitationId: z
      .uuid()
      .describe(
        "The invitation acted on. Resolved against the acting organization, so a member of one account cannot probe another's invitation ids.",
      ),
  })
  .describe("Which outstanding offer a withdrawal names.");
export type InvitationParam = z.output<typeof InvitationParam>;

/** The body of `PATCH {base}/current/members/:membershipId`. */
export const ChangeRole = z
  .object({ role: RoleName })
  .describe("What a member's role becomes. The store refuses a role the catalog excludes from assignment.");
export type ChangeRole = z.output<typeof ChangeRole>;

/**
 * The body of `POST {base}/current/invitations`.
 *
 * **The address is shape-checked here and nowhere else that matters.** `invite()` normalizes rather
 * than validates — `normalizeAddress` is total by design — and the column's `min(3)` is a backstop that
 * would fail as a `ZodError` from inside a write. A mailbox is what this offer binds to, so the bound
 * belongs at the boundary.
 */
export const InviteMember = z
  .object({
    email: z
      .email()
      .max(MAX_ADDRESS_LENGTH)
      .describe(
        "The address invited. Normalized before it is written, and compared against the accepting session's own address at redemption — which is what makes a forwarded link useless.",
      ),
    role: RoleName,
  })
  .describe("An offer of membership to an address, at a role.");
export type InviteMember = z.output<typeof InviteMember>;

/**
 * The body of `POST {base}/invitations/accept`.
 *
 * **In the body, not the path.** A token in a URL reaches the referrer header, the browser history and
 * every log between here and the origin; this one is a 256-bit credential that creates a membership.
 * The link in the mail carries it for a person to click, and the screen behind that link posts it.
 */
export const AcceptInvitation = z
  .object({
    token: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "The invitation token, as the accept link carried it. Matched by digest — the plaintext is in the mail and in no row.",
      ),
  })
  .describe("The token that redeems one offer of membership.");
export type AcceptInvitation = z.output<typeof AcceptInvitation>;

/** The body of `POST {base}/current/ownership` — offer the account to somebody already in it. */
export const NominateOwner = z
  .object({
    membershipId: z
      .uuid()
      .describe(
        "The nominee's membership, never their user id. An offer is made to somebody already inside the account, and the offer dies with the membership.",
      ),
  })
  .describe("Who the account is being offered to. An offer, not a transfer — nothing moves until they accept.");
export type NominateOwner = z.output<typeof NominateOwner>;

/** The path parameters of `GET {base}/marks/organization/:organizationId`. */
export const OrganizationMarkParam = z
  .object({
    organizationId: z
      .uuid()
      .describe(
        "Whose mark to serve. Proved against a membership of the caller — the only route here that names an organization and is not the choice, because the chooser draws these before anything is in force.",
      ),
  })
  .describe("Which organization's mark a chooser is drawing.");
export type OrganizationMarkParam = z.output<typeof OrganizationMarkParam>;

/** The path parameters of `GET {base}/marks/member/:membershipId`. */
export const MemberMarkParam = z
  .object({
    membershipId: z
      .uuid()
      .describe(
        "Whose face to serve, named by membership rather than by user — so entitlement is the roster the face is already drawn on, and a foreign id is the same 404 as one that does not exist.",
      ),
  })
  .describe("Which member's face the roster is drawing.");
export type MemberMarkParam = z.output<typeof MemberMarkParam>;

/**
 * ## The management surface, below
 *
 * Everything above bounds what a **member** may send. The two below bound what a **management client**
 * may ask for, and verified is not the same as trusted: a control-plane credential proves who is
 * calling, not that their listing is sane, and a client with a bug asks for a million rows exactly as
 * easily as a hostile one does.
 */

/** How many rows a bounded management listing returns, when the caller names a number. */
export const AdminListQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe("How many rows to return. Bounded, because a verified client can still have a bug."),
  })
  .describe("The bound on a management listing. No cursor: this surface says which account to look at.");
export type AdminListQuery = z.output<typeof AdminListQuery>;

/**
 * The path parameters of the management route that names one tenant.
 *
 * **No 404 rule to keep here.** The byte-identical refusal exists because a member must not be able to
 * tell "does not exist" from "not yours"; a management caller holding `organization:accounts:read` may
 * list every account there is, so there is nothing for this id to be an oracle for.
 */
export const AdminOrganizationParam = z
  .object({ organizationId: z.uuid().describe("Which tenant's roster to read.") })
  .describe("The path parameters of the management roster route.");
export type AdminOrganizationParam = z.output<typeof AdminOrganizationParam>;

/**
 * The path parameters of `GET {base}/invitations/:token` — the read behind the link in the mail.
 *
 * **The token is in the path here and in the body of the accept**, and the asymmetry is the mail's
 * rather than an inconsistency. A link in an email cannot post; `invitationAcceptUrl` therefore mints
 * `{base}/invitations/{token}`, and this route is what that URL resolves to. What it answers is the
 * three facts an accept screen renders — which account, who asked, at what role — and it grants
 * nothing: {@link AcceptInvitation} is still the only way a membership is written, and it carries the
 * token where a referrer header cannot reach it.
 */
export const InvitationTokenParam = z
  .object({
    token: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "The invitation token, as the link carried it. Matched by digest, and every refusal — unknown, spent, withdrawn, expired — is the same sentence, so the route is no oracle for which offers exist.",
      ),
  })
  .describe("Which offer the screen behind an invitation link is about to render.");
export type InvitationTokenParam = z.output<typeof InvitationTokenParam>;
