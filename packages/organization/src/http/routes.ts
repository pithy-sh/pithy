// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type AuthDatabase, authDatabase } from "@pithy-sh/auth/src/data/tables";
import type { LifecycleDeps } from "@pithy-sh/auth/src/lifecycle/transitions";
import { AUTH_PURGE_BINDING } from "@pithy-sh/auth/src/purge/specs";
import { startPurgeInstance } from "@pithy-sh/auth/src/purge/start";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import type { AmbientEnv } from "@pithy-sh/core/src/env/ambient";
import { InternalError, NotFoundError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute, type RouteResponse } from "@pithy-sh/core/src/http/routeSpec";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import { STORED_IMAGE_HEADERS, storedImageBytes } from "@pithy-sh/core/src/image/storedImage";
import { migrateStep } from "@pithy-sh/core/src/migrations/migrateStep";
import { workflowBindingFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  chooseActing,
  countSuspended,
  listActable,
  noSuchOrganization,
  resolveActing,
  resolveSelection,
} from "../acting/acting";
import { OrganizationAuditActions } from "../audit/actions";
import {
  correlation,
  type OrganizationAuditEvent,
  type OrganizationOperatorEvent,
  recordOperatorAction,
  recordOrganizationAction,
} from "../audit/emit";
import type { OrganizationConfig } from "../config/config";
import { Invitation } from "../data/invitation";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import {
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  type OrganizationDatabase,
  organizationDatabase,
} from "../data/tables";
import { OrganizationForbiddenError, OrganizationInvitationInvalidError } from "../error/errors";
import {
  acceptInvitation,
  invite,
  listInvitations,
  requireInvitationInOrganization,
  resendInvitation,
  withdrawInvitation,
} from "../invite/invite";
import { invitationDigest } from "../invite/token";
import {
  type CascadeOutcome,
  deleteSoleMembers,
  membersStillShut,
  NO_CASCADE,
  planDeletion,
  planSuspension,
  suspendSoleMembers,
  type UserLifecycleWiring,
} from "../lifecycle/cascade";
import type { OrganizationLifecycleHooks } from "../lifecycle/hooks";
import { organizationStanding } from "../lifecycle/state";
import {
  absent,
  checkSuspension,
  type OrganizationLifecycleDeps,
  reinstateOrganization,
  removeOrganization,
  restoreOrganization,
  suspendOrganization,
} from "../lifecycle/transitions";
import { type EnqueueInvitation, invitationAcceptUrl, sendInvitationMail } from "../mail/invitation";
import { notifyOwners } from "../mail/lifecycle";
import { type NoticeRecipient, sendMembershipNotice } from "../mail/membership";
import {
  addMember,
  changeRole,
  changeRoleAsOperator,
  leaveOrganization,
  listMembers,
  type OwnerRule,
  removeMember,
  removeMemberAsOperator,
  requireMayAssign,
  requireMembershipInOrganization,
} from "../members/members";
import {
  acceptNomination,
  forceOwnership,
  nominate,
  type OwnershipRoles,
  standingNomination,
  withdrawNomination,
} from "../ownership/ownership";
import { MEMBERS_PATH_SEGMENT, readPeople } from "../people/people";
import {
  createOrganization,
  deleteOrganization,
  type OrganizationDeleteSweep,
  renameOrganization,
  setLogo,
  updateOrganizationAsOperator,
} from "../provision/provision";
import { ORGANIZATION_PURGE_BINDING } from "../purge/specs";
import { startOrganizationPurgeInstance } from "../purge/start";
import type { KitPower, RoleCatalog } from "../roles/roles";
import { type OrganizationGuardDeps, type OrganizationHonoEnv, requireOrganization, requirePower } from "./guard";
import {
  AcceptInvitationResponse,
  ActingResponse,
  AdminInvitationsResponse,
  AdminMemberCascadePreviewResponse,
  AdminMemberResponse,
  AdminMembersResponse,
  AdminOrganizationDeleteResponse,
  AdminOrganizationReinstateResponse,
  AdminOrganizationResponse,
  AdminOrganizationRestoreResponse,
  AdminOrganizationSuspendResponse,
  AdminOrganizationsResponse,
  AdminOwnershipResponse,
  AdminRemovedMemberResponse,
  DeletedOrganizationResponse,
  InvitationOfferResponse,
  InvitationsResponse,
  InviteResponse,
  MemberRoleResponse,
  MembersResponse,
  NominationResponse,
  OrganizationRecordResponse,
  OrganizationResponse,
  OrganizationsResponse,
  RemovedMemberResponse,
  TransferResponse,
  WithdrawnInvitationResponse,
} from "./responses";
import {
  AcceptInvitation,
  AdminAddMember,
  AdminChangeRole,
  AdminDeleteOrganization,
  AdminForceOwnership,
  AdminInvitationParam,
  AdminInvitationsQuery,
  AdminListQuery,
  AdminMembershipParam,
  AdminOrganizationParam,
  AdminReason,
  AdminSuspendOrganization,
  AdminUpdateOrganization,
  ChangeRole,
  ChooseOrganization,
  createOrganizationBody,
  InvitationParam,
  InvitationTokenParam,
  InviteMember,
  MemberMarkParam,
  MembershipParam,
  NominateOwner,
  OrganizationMarkParam,
  UpdateOrganization,
} from "./schemas";
import {
  ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
  ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
  ORGANIZATION_MEMBERS_READ_SCOPE,
  ORGANIZATION_MEMBERS_WRITE_SCOPE,
  ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE,
} from "./scopes";
import {
  actingView,
  adminMemberView,
  adminOrganizationView,
  deletionView,
  invitationOfferView,
  invitationView,
  MARKS_SEGMENT,
  memberCascadeView,
  membershipView,
  memberView,
  nominationView,
  organizationView,
  suspensionView,
} from "./views";

/**
 * The tenancy route surface: what each route accepts, and what proves the caller may call it.
 *
 * | Route                                          | Verification   | Power                 | Input                          |
 * | ---------------------------------------------- | -------------- | --------------------- | ------------------------------ |
 * | `GET    {base}`                                | session        | —                     | none                           |
 * | `POST   {base}`                                | session        | — (see self-service)  | json `CreateOrganization`      |
 * | `POST   {base}/acting`                         | session        | —                     | json `ChooseOrganization`      |
 * | `GET    {base}/current`                        | session        | `organization:read`   | none                           |
 * | `PATCH  {base}/current`                        | session        | `organization:manage` | json `UpdateOrganization`      |
 * | `DELETE {base}/current`                        | session        | `organization:delete` | none                           |
 * | `GET    {base}/current/members`                | session        | `organization:read`   | none                           |
 * | `PATCH  {base}/current/members/:membershipId`  | session        | `organization:manage` | param + json `ChangeRole`      |
 * | `DELETE {base}/current/members/:membershipId`  | session        | `organization:manage` | param `MembershipParam`        |
 * | `POST   {base}/current/members/leave`          | session        | —                     | none                           |
 * | `GET    {base}/current/invitations`            | session        | `organization:manage` | none                           |
 * | `POST   {base}/current/invitations`            | session        | `organization:manage` | json `InviteMember`            |
 * | `DELETE {base}/current/invitations/:id`        | session        | `organization:manage` | param `InvitationParam`        |
 * | `GET    {base}/invitations/:token`             | public         | —                     | param `InvitationTokenParam`   |
 * | `POST   {base}/invitations/accept`             | session        | —                     | json `AcceptInvitation`        |
 * | `POST   {base}/current/ownership`              | session        | holder, or administers | json `NominateOwner`          |
 * | `DELETE {base}/current/ownership`              | session        | holder, or unheld     | none                           |
 * | `POST   {base}/ownership/accept`               | session        | —                     | none                           |
 * | `GET    {base}/marks/organization/:id`         | session        | — (membership)        | param `OrganizationMarkParam`  |
 * | `GET    {base}/members/:membershipId/image`    | session        | `organization:read`   | param `MemberMarkParam`        |
 * | `GET    {base}/admin/organizations`            | control-plane  | scope                 | query `AdminListQuery`         |
 * | `GET    {base}/admin/organizations/:id/members`| control-plane  | scope                 | param + query                  |
 * | `PATCH  {base}/admin/organizations/:id`        | control-plane  | `accounts:write`      | param + json `AdminUpdateOrganization` |
 * | `POST   {base}/admin/organizations/:id/members`| control-plane  | `members:write` ¹     | param + json `AdminAddMember`  |
 * | `PATCH  {base}/admin/…/members/:membershipId`  | control-plane  | `members:write` ¹     | param + json `AdminChangeRole` |
 * | `DELETE {base}/admin/…/members/:membershipId`  | control-plane  | `members:write` ¹     | param + json `AdminReason`     |
 * | `GET    {base}/admin/…/invitations`            | control-plane  | `members:write`       | param + query `AdminInvitationsQuery` |
 * | `POST   {base}/admin/…/invitations/:id/resend` | control-plane  | `members:write`       | param + json `AdminReason`     |
 * | `DELETE {base}/admin/…/invitations/:id`        | control-plane  | `members:write`       | param + json `AdminReason`     |
 * | `POST   {base}/admin/…/ownership`              | control-plane  | `ownership:transfer`  | param + json `AdminForceOwnership` |
 * | `POST   {base}/admin/organizations/:id/suspend`  | control-plane  | `accounts:suspend`  | param + json `AdminSuspendOrganization` |
 * | `POST   {base}/admin/…/suspend/preview`          | control-plane  | `accounts:suspend`  | param + json `AdminSuspendOrganization` ² |
 * | `POST   {base}/admin/organizations/:id/reinstate`| control-plane  | `accounts:suspend`  | param + json `AdminReason`     |
 * | `DELETE {base}/admin/organizations/:id`          | control-plane  | `accounts:delete`   | param + json `AdminDeleteOrganization` |
 * | `POST   {base}/admin/…/delete/preview`           | control-plane  | `accounts:delete`   | param + json `AdminDeleteOrganization` ² |
 * | `POST   {base}/admin/organizations/:id/restore`  | control-plane  | `accounts:delete`   | param + json `AdminReason`     |
 *
 * ¹ Never an add at the owning role, a role change to or from it, or the removal of an owner, whatever
 * else the connection is granted: each is refused 403, naming the ownership route. A token is minted for
 * one scope, and these are minted for `members:write`, so the connection's `ownership:transfer` grant is
 * not this call's authority. Otherwise a roster token could add a second owner and remove the first — a
 * transfer by another door, with no ownership-scoped call, no forced-ownership event and no notice.
 *
 * ² A preview (#813): the write's own body, scope and refusals, answering who its member cascade would reach
 * with nothing applied. Writes nothing — no column, history row, mail, hook or audit act — so it is declared
 * not mutating, though it is a `POST`: it carries the write's body, and a body is not a query string.
 *
 * ## The operator's writes take no CSRF gate, and every one takes a reason
 *
 * A control-plane call is authenticated by a signed token in a header a browser never attaches on its
 * own, so the cross-site request `requireSameOrigin()` exists to refuse cannot carry one. Its gate is
 * `requireControlPlane(scope)`, first on the line, ahead of every validator — the same ordering rule,
 * for the same reason. The reason is a required field of every body and of the one query, and it reaches
 * the trail through `recordOperatorAction` with the operator, the connection and the subject beside it.
 *
 * ## Three routes name an organization, and every other one is the session's
 *
 * The acting organization is session state — `../data/actingOrganization.ts` argues why at length — so a
 * scoped route has no field and no path segment that could carry another tenant's id. `POST {base}/acting`
 * is where a caller names one, and it is the single write that turns a supplied id into a membership.
 * The mark route names one because the chooser draws marks before anything is in force. The admin
 * roster route names one because a management credential holds no membership to be in force at all.
 *
 * ## `requireSameOrigin()` is the **first** middleware on every mutating route, not the last
 *
 * Every other gate here is about the caller; this one is about where the request came from, and it is
 * the cheapest and least revealing of the three. Running it first means a cross-origin post is refused
 * before a query runs and before a validator reports which bodies are well-formed — and it gives
 * `routeContract.test.ts` a discriminator no middleware count could be: with no capability publishing an
 * origin policy the gate denies with `auth/forbidden`, so a mutating route that lost its CSRF guard
 * answers `core/unauthorized` instead and the suite fails. A rule that can only be checked by reading
 * the file is a rule that stops holding on the day somebody adds a route in a hurry.
 *
 * ## Validators sit after the gates, except where a gate reads one
 *
 * A validator ahead of a gate turns a 403 into a 400 and tells a caller who has proved nothing which
 * requests were well-formed. The exception is the two routes that **name** an organization or a
 * membership: `requireOrganization(deps, named)` reads the id back through `c.req.valid(...)`, so the
 * schema has to be declared above it. Nothing is lost — the only thing a caller learns there is whether
 * their id was a UUID, which they wrote.
 *
 * ## The ownership routes mount only when the transfer's roles are wired
 *
 * A transfer moves a pair — the role somebody takes, and the role the previous holder falls back to —
 * and `../ownership/ownership.ts` refuses to run one whose conferred role is assignable. A catalog that
 * excludes nothing has no such pair, and for it the two-party transfer is not a feature that is broken
 * but a feature that does not exist. Mounting routes that could only ever refuse would be worse than not
 * mounting them, so {@link OrganizationRoutesOptions.ownership} decides, and the route contract pins
 * both surfaces.
 */

/** One route this capability mounts, and everything that has to be true about it. */
export interface OrganizationRouteDeclaration {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path relative to the configured `basePath`. Empty string is the base itself. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The kit power the route demands, for a route gated by one. */
  readonly power?: KitPower;
  /** The control-plane scope, for a `control-plane` route. */
  readonly scope?: ControlPlaneScope;
  /**
   * Whether the route changes something. A mutating `session` route wears `requireSameOrigin()`; a
   * mutating `control-plane` route is authenticated by a signed header no browser sends on its own, and
   * wears `requireControlPlane(scope)` first instead.
   */
  readonly mutating: boolean;
  /** Whether the route exists only where {@link OrganizationRoutesOptions.ownership} is wired. */
  readonly ownership?: true;
}

/**
 * Every route, and how it is gated.
 *
 * **A declaration rather than an inference, so it can drift from the router** — and `routeContract.test.ts`
 * is what stops it, checking this list against what Hono actually mounted in both directions. A route
 * added without an entry and an entry naming a route nobody mounts both fail there, which is what makes
 * this table the one record of a route's verification strategy rather than a comment about one.
 */
export const ORGANIZATION_ROUTES: readonly OrganizationRouteDeclaration[] = [
  { method: "GET", path: "", strategy: "session", mutating: false },
  { method: "POST", path: "", strategy: "session", mutating: true },
  { method: "POST", path: "/acting", strategy: "session", mutating: true },
  { method: "GET", path: "/current", strategy: "session", power: "organization:read", mutating: false },
  { method: "PATCH", path: "/current", strategy: "session", power: "organization:manage", mutating: true },
  { method: "DELETE", path: "/current", strategy: "session", power: "organization:delete", mutating: true },
  { method: "GET", path: "/current/members", strategy: "session", power: "organization:read", mutating: false },
  {
    method: "PATCH",
    path: "/current/members/:membershipId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  {
    method: "DELETE",
    path: "/current/members/:membershipId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  { method: "POST", path: "/current/members/leave", strategy: "session", mutating: true },
  { method: "GET", path: "/current/invitations", strategy: "session", power: "organization:manage", mutating: false },
  { method: "POST", path: "/current/invitations", strategy: "session", power: "organization:manage", mutating: true },
  {
    method: "DELETE",
    path: "/current/invitations/:invitationId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  // A resend revives an offer of a role, so it spends `requireMayAssign` again — on the role the stored
  // row holds, never the request's.
  {
    method: "POST",
    path: "/current/invitations/:invitationId/resend",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  // Public, and it grants nothing. The link in the mail resolves here; acceptance is the POST below.
  { method: "GET", path: "/invitations/:token", strategy: "public", mutating: false },
  { method: "POST", path: "/invitations/accept", strategy: "session", mutating: true },
  /*
    **None of the three names a power, and that is the correction rather than an omission.**

    The obvious gate — `billing:manage` on the two mutations — closes the account permanently in the
    catalog this kit scaffolds: the conferred role holds that power and nothing else does, and a founded
    account has no holder of it. So "anybody in the account may volunteer" became "the owner the account
    does not have", and since the conferred role is unassignable there was no route that could repair it.

    What replaces it is the rule `ownership.ts` already held, which is conditional in a way a power
    cannot be: while somebody holds the account only they hand it on or take an offer back, and while
    nobody does, somebody who already administers it may volunteer themselves and appoint nobody else. On a held account that
    is *stronger* than the power it replaced, because it names the holder rather than a power the holder
    happens to have.

    The read is membership alone for a different reason: the nominee is by definition the person who does
    not hold the account yet, so any power gate would hide the offer from the one caller it exists for.
  */
  { method: "GET", path: "/current/ownership", strategy: "session", mutating: false, ownership: true },
  { method: "POST", path: "/current/ownership", strategy: "session", mutating: true, ownership: true },
  { method: "DELETE", path: "/current/ownership", strategy: "session", mutating: true, ownership: true },
  { method: "POST", path: "/ownership/accept", strategy: "session", mutating: true, ownership: true },
  { method: "GET", path: `${MARKS_SEGMENT}/organization/:organizationId`, strategy: "session", mutating: false },
  {
    method: "GET",
    path: `${MEMBERS_PATH_SEGMENT}/:membershipId/image`,
    strategy: "session",
    power: "organization:read",
    mutating: false,
  },
  {
    method: "GET",
    path: "/admin/organizations",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_READ_SCOPE,
    mutating: false,
  },
  {
    method: "GET",
    path: "/admin/organizations/:organizationId/members",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_READ_SCOPE,
    mutating: false,
  },
  // Membership administration (#624). Every one takes a reason; each scope names a blast radius.
  {
    method: "PATCH",
    path: "/admin/organizations/:organizationId",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
    mutating: true,
  },
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/members",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: true,
  },
  {
    method: "PATCH",
    path: "/admin/organizations/:organizationId/members/:membershipId",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: true,
  },
  {
    method: "DELETE",
    path: "/admin/organizations/:organizationId/members/:membershipId",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: true,
  },
  // A read, under the write scope: the list is addresses, and it is read to fix one of them.
  {
    method: "GET",
    path: "/admin/organizations/:organizationId/invitations",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: false,
  },
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/invitations/:invitationId/resend",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: true,
  },
  {
    method: "DELETE",
    path: "/admin/organizations/:organizationId/invitations/:invitationId",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
    mutating: true,
  },
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/ownership",
    strategy: "control-plane",
    scope: ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE,
    mutating: true,
    ownership: true,
  },
  // The organization's own lifecycle (#623). Each takes a reason; each scope is a power over whether the account
  // exists for its members at all.
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/suspend",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
    mutating: true,
  },
  // Who the suspension's cascade would reach, before it runs (#813). Behind the write's scope: who belongs to no
  // other organization is a disclosure only a caller who could act on it gets. Writes nothing.
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/suspend/preview",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
    mutating: false,
  },
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/reinstate",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
    mutating: true,
  },
  {
    method: "DELETE",
    path: "/admin/organizations/:organizationId",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
    mutating: true,
  },
  // The deletion's preview, on the same terms as the suspension's (#813).
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/delete/preview",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
    mutating: false,
  },
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/restore",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
    mutating: true,
  },
];

/**
 * How every member-facing route verifies its caller. The local `requireAuth()` and `requireOrganization()`
 * both accept any resolved `AuthContext`, and `@pithy-sh/auth` resolves one from a bearer token or a session.
 */
const signedIn: readonly VerificationStrategy[] = ["bearer", "session"];

/** What the two mark routes serve: stored raster bytes. A vector is never served here. */
const RASTER_MARK: RouteResponse = {
  description: "The stored raster bytes, PNG, JPEG or WebP, with the type the bytes carry.",
  contentType: "image/*",
};

/** Milliseconds in a day, for the one arithmetic this module does. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many organization ids one statement resolves at a time.
 *
 * D1 binds a bounded number of parameters, and the chooser's second read is `where id in (…)` over
 * whatever the membership join returned. Chunked rather than capped: somebody in two hundred accounts
 * gets four statements and a complete list, where a cap would hand them a short one presented as whole.
 */
const ID_LOOKUP_CHUNK = 50;

/** What `registerOrganizationRoutes` takes. */
export interface OrganizationRoutesOptions<Power extends string, Role extends string> {
  /** The project's declared catalog. Every authorization question here is asked of it. */
  readonly catalog: RoleCatalog<Power, Role>;
  /** The resolved configuration. */
  readonly config: OrganizationConfig;
  /** Where the routes mount. Defaults to the config's own `basePath`. */
  readonly basePath?: string;
  /** The name of the D1 binding the tenancy tables live in. Defaults to `DB`. */
  readonly databaseBinding?: string;
  /**
   * The two roles a transfer of ownership moves — read from **one** place and handed to both ends.
   *
   * Absent means this project has no two-party transfer, and the three ownership routes do not mount.
   * The type system cannot stop a caller passing one pair to the offer and another to the acceptance;
   * reading the constant from here is what does.
   */
  readonly ownership?: OwnershipRoles<Role>;
  /** The adopter's own tenanted deletes, run in the transaction that deletes the account. */
  readonly onDelete?: OrganizationDeleteSweep;
  /**
   * The email enqueue seam.
   *
   * Takes the request env rather than being pre-bound, because a Worker's `env` is per-request: a seam
   * captured at registration would close over whichever request happened to assemble the routes.
   */
  readonly enqueue?: (env: Record<string, unknown>) => EnqueueInvitation | undefined;
  /** The adopter's organization-lifecycle hooks (#623). */
  readonly lifecycleHooks?: OrganizationLifecycleHooks;
  /**
   * The composed `@pithy-sh/auth`'s lifecycle config and user hooks, which a member cascade runs through (#623).
   * A function, because `compose` fills it after the routes are registered. Absent, a cascade that would reach a
   * member refuses rather than guessing auth's config.
   */
  readonly userLifecycle?: () => UserLifecycleWiring | undefined;
  /** The clock. Injected so expiries and stored timestamps are deterministic in tests. */
  readonly now?: () => Date;
  /** The id source. Injected for the same reason. */
  readonly newId?: () => string;
}

/**
 * Require an authenticated caller.
 *
 * **Copied rather than imported from `@pithy-sh/auth`**, matching every other capability in the repo: a
 * package that borrows its authorization fails *open* when the lender is absent. With the guard local, a
 * project that never composed auth leaves `c.var.auth` null and every gated route denies — the only
 * acceptable direction for that failure to go. `requireOrganization()` performs the same check for
 * itself; this is for the four routes that have no organization to resolve.
 */
function requireAuth<Role extends string>(): MiddlewareHandler<OrganizationHonoEnv<Role>> {
  return async (c, next) => {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Sign in to continue.",
        action: "Retry with a valid session or bearer token.",
        detail: "an organization route ran with no resolved session",
      });
    }
    await next();
  };
}

/**
 * Register the tenancy routes onto the backend's Hono app.
 *
 * **The cast at the top is the single seam a capability adding a context variable has to spend.** Hono's
 * `Context` is invariant in its env, so routes that read `c.var.acting` cannot be typed against the base
 * `PithyHonoEnv` the `routes` hook hands over. One cast here, at assembly, rather than one per handler:
 * the variable is set by `requireOrganization()` and by nothing else, so what makes it true is the gate
 * on the route line and not the type.
 */
export function registerOrganizationRoutes<Power extends string, Role extends string>(
  options: OrganizationRoutesOptions<Power, Role>,
): (app: Hono<PithyHonoEnv>) => void {
  const { catalog, config } = options;
  const base = options.basePath ?? config.basePath;
  const binding = options.databaseBinding ?? "DB";
  const clock = options.now ?? (() => new Date());
  const ids = options.newId ?? (() => crypto.randomUUID());

  type Env = OrganizationHonoEnv<Role>;
  type Ctx = Context<Env>;

  /** The D1 binding this invocation was given, or a stated wiring failure rather than a silent undefined. */
  function d1(c: Ctx): D1Database {
    const found = (c.env as Record<string, unknown>)[binding];
    if (!found) {
      throw new InternalError({
        message: "The organization database is not configured.",
        action: `Bind a D1 database named ${binding} in wrangler.jsonc, then ${migrateStep(c.env as AmbientEnv)}.`,
        detail: `the organization routes require a "${binding}" D1 binding; none was present on env`,
      });
    }
    return found as D1Database;
  }

  const db = (c: Ctx): OrganizationDatabase => organizationDatabase(d1(c));
  const auth = (c: Ctx): AuthDatabase => authDatabase(d1(c));

  const deps: OrganizationGuardDeps<Power, Role> = {
    catalog,
    now: clock,
    database: (env) => {
      const found = env[binding];
      if (!found) {
        throw new InternalError({
          message: "The organization database is not configured.",
          action: `Bind a D1 database named ${binding} in wrangler.jsonc, then ${migrateStep(env as AmbientEnv)}.`,
          detail: `the organization gates require a "${binding}" D1 binding; none was present on env`,
        });
      }
      return organizationDatabase(found as D1Database);
    },
  };

  // The published CSRF gate, read back rather than rebuilt. It arrives already bound to the origins the
  // composing capability resolved, so there is no origin list to pass and therefore no wrong one. The
  // cast is the invariance seam the function docblock names, spent once.
  const csrf = requireSameOrigin() as unknown as MiddlewareHandler<Env>;
  const gate = (scope: ControlPlaneScope): MiddlewareHandler<Env> =>
    requireControlPlane(scope) as unknown as MiddlewareHandler<Env>;

  /** The signed-in caller. Every route calling this has a gate above it, so a null here is a wiring fault. */
  function session(c: Ctx): { userId: string; sessionId: string } {
    const resolved = c.var.auth;
    if (!resolved) {
      throw new InternalError({ detail: "requireAuth() must run before an organization handler reads the caller." });
    }
    return { userId: resolved.userId, sessionId: resolved.sessionId };
  }

  /** Record one administrative act, with this request's correlation and the session that took it. */
  async function record(c: Ctx, event: Omit<OrganizationAuditEvent, "ip" | "userAgent" | "sessionId">): Promise<void> {
    await recordOrganizationAction(c.var.emit, {
      ...event,
      ...correlation(c.req.raw.headers),
      sessionId: c.var.auth?.sessionId ?? null,
    });
  }

  /** The verified management caller. Every route calling this has `requireControlPlane` above it. */
  function operator(c: Ctx): ControlPlaneContext {
    const caller = c.var.controlPlane;
    if (!caller) {
      throw new InternalError({
        detail: "requireControlPlane() must run before an operator handler reads the caller.",
      });
    }
    return caller;
  }

  /** Record one operator act inside `organizationId`, with this request's correlation and the verified caller. */
  async function recordOperator(
    c: Ctx,
    organizationId: string,
    event: Omit<OrganizationOperatorEvent, "operator" | "ip" | "userAgent" | "requestId">,
  ): Promise<void> {
    const caller = operator(c);
    await recordOperatorAction(c.var.emit, {
      ...event,
      operator: { organizationId, subject: caller.subject, connectionId: caller.connectionId },
      ...correlation(c.req.raw.headers),
      requestId: c.req.header("cf-ray") ?? null,
    });
  }

  /**
   * The tenant an operator route names, or the ordinary 404.
   *
   * A 404 and never a 403: the caller has already been verified and scoped, so the only thing left to say
   * about an id is whether it names an account. Asked first on every operator route, so a refusal about a
   * member or a role is never what an operator naming a typo'd account is told.
   */
  async function operatorOrganization(c: Ctx, organizationId: string): Promise<Organization> {
    const found = await findOrganization(db(c), organizationId);
    if (!found) throw noSuchOrganization(`operator named organization ${organizationId}, which does not exist`);
    return found;
  }

  /**
   * The owning role, as the operator's roster writes read it, or nothing where there is no transfer.
   *
   * `mayConfer` is false, always. A roster write that moves the owning role is a transfer by another
   * door, and the token behind it was minted for `organization:members:write` alone — the connection's
   * wider grant is not this call's authority (`scopeCovers`). So an add at the owning role, a change to or
   * from it, or the removal of an owner is refused, naming the ownership route, where the move is made
   * under its own scope, recorded at `warning`, and the new owner is told.
   */
  function ownerRule(organizationId: string): OwnerRule<Role> | undefined {
    if (!options.ownership) return undefined;
    return {
      role: options.ownership.confers,
      transferRoute: `${base}/admin/organizations/${organizationId}/ownership`,
      mayConfer: false,
    };
  }

  /** One membership row, decoded, or the ordinary member 404. */
  async function readMembership(
    database: OrganizationDatabase,
    organizationId: string,
    id: string,
  ): Promise<Membership> {
    const row = await database
      .selectFrom(MEMBERSHIPS_TABLE)
      .selectAll()
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    if (!row)
      throw new NotFoundError({
        message: "No such member.",
        detail: `membership ${id} is gone from ${organizationId}`,
      });
    return Membership.parse(row);
  }

  /** The enqueue seam for this request, or undefined where no email is composed. */
  const mailer = (c: Ctx): EnqueueInvitation | undefined => options.enqueue?.(c.env as Record<string, unknown>);

  /**
   * The refusals worth a row, and the reason each one is.
   *
   * Four, and every one is a refusal of somebody the account had already let in — which is what makes it
   * different from a stranger's 404 and what makes it worth alerting on.
   *
   * `organization/forbidden` — a proved member reached above their role.
   * `organization/last_administrator` — an attempt to leave the account unadministrable.
   * `organization/invitation_invalid` — a token presented and refused, the wrong-address case included.
   * `organization/nomination_invalid` — an ownership acceptance that was not this caller's to make.
   */
  const RECORDED_REFUSALS: ReadonlySet<string> = new Set([
    "organization/forbidden",
    "organization/last_administrator",
    "organization/invitation_invalid",
    "organization/nomination_invalid",
  ]);

  /**
   * Record a refusal, when it is one of the four above.
   *
   * **`facts` carries the refusal's own code and nothing else from the error.** `detail` is the operator
   * half and it is written to hold ids, a junk role, an organization somebody named — none of which the
   * trail's own rule admits, and one of which (`invite`'s) would put an address in a register that
   * refuses anything address-shaped. The code is the fact a reader filters on; the sentence stays in the
   * log, where it already is.
   *
   * Swallows its own failure, as every emit here does: a trail that cannot be written must not turn a
   * refusal into a 500 and tell the caller something different about themselves than the truth.
   */
  async function recordRefusal(c: Ctx, error: unknown): Promise<void> {
    const code = (error as { payload?: { code?: unknown } } | null)?.payload?.code;
    if (typeof code !== "string" || !RECORDED_REFUSALS.has(code)) return;
    const who = c.var.auth;
    if (!who) return;
    /*
      **An acting organization, or no row — and the one case that excludes is the interesting one to
      state.** A trail event belongs to a tenant, and `organization/invitation_invalid` is reachable on
      `POST /invitations/accept`, which has no acting selection by design: the caller is joining, so
      there is nothing in force yet. The organization the token pointed at is known to the handler and
      is exactly what the refusal exists to hide, so writing the row under it would say through the trail
      what the response would not. There is no tenant to attribute it to, and inventing one is worse than
      the gap.

      The same refusal *inside* an account — an offer redeemed by the wrong address by somebody already a
      member, which is the case worth alerting on — does have one, and is recorded.
    */
    const acting = c.get("acting");
    if (!acting) return;
    await record(c, {
      action: OrganizationAuditActions.refused,
      actor: { organizationId: acting.organizationId, userId: who.userId },
      // The account itself. A refusal is about standing in the organization rather than about whichever
      // row the caller happened to name — and the row they named is often the thing the refusal hides.
      resource: { type: "organization", id: acting.organizationId },
      outcome: "denied",
      facts: { refusal: code, route: new URL(c.req.raw.url).pathname },
    });
  }

  /** One organization row, or null. Nothing is decided here — the caller says what absence means. */
  async function findOrganization(database: OrganizationDatabase, id: string): Promise<Organization | null> {
    const row = await database.selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
    return row ? Organization.parse(row) : null;
  }

  /**
   * The organization a gate already proved a membership in.
   *
   * Absence here is a row deleted between the gate and this read, and it answers the same 404 as every
   * other absence in the capability — because a caller must not be able to tell a race apart from an
   * account that was never theirs.
   */
  async function readOrganization(database: OrganizationDatabase, id: string): Promise<Organization> {
    const found = await findOrganization(database, id);
    if (!found) throw noSuchOrganization(`organization ${id} was gone by the time a proved membership read it`);
    return found;
  }

  /** Organization rows by id, chunked to stay inside D1's bound-parameter budget. */
  async function readOrganizations(
    database: OrganizationDatabase,
    organizationIds: readonly string[],
  ): Promise<Map<string, Organization>> {
    const found = new Map<string, Organization>();
    for (let at = 0; at < organizationIds.length; at += ID_LOOKUP_CHUNK) {
      const chunk = organizationIds.slice(at, at + ID_LOOKUP_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await database.selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "in", chunk).execute();
      for (const row of rows) {
        const organization = Organization.parse(row);
        found.set(organization.id, organization);
      }
    }
    return found;
  }

  /**
   * How many rows one organization holds in a table.
   *
   * A count rather than the length of a list, because the record pane wants a number and reading a
   * five-hundred-person roster to report `500` is a page of bytes spent on one integer.
   */
  async function countRows(
    database: OrganizationDatabase,
    table: typeof MEMBERSHIPS_TABLE | typeof INVITATIONS_TABLE,
    organizationId: string,
    pendingOnly = false,
  ): Promise<number> {
    let query = database
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where("organizationId", "=", organizationId);
    if (pendingOnly) query = query.where("status", "=", "pending");
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.total);
  }

  /** Serve stored bytes, or 404 — which is also the answer for a vector, and that is the whole gate. */
  function serveMark(stored: string | null, why: string): Response {
    const bytes = storedImageBytes(stored);
    if (!bytes) {
      // One answer for three facts — nothing stored, a vector, a value the allowlist does not match. The
      // caller has already been proved entitled to look, so none of them is a secret; they are one answer
      // because the route has exactly one thing to say, which is *nothing to serve here*.
      throw new NotFoundError({ message: "No mark to show.", detail: why });
    }
    return new Response(bytes.body as unknown as BodyInit, {
      headers: { "content-type": bytes.type, ...STORED_IMAGE_HEADERS },
    });
  }

  /** The one refusal an unredeemable link gets, in every one of its forms. */
  function offerInvalid(why: string): OrganizationInvitationInvalidError {
    return new OrganizationInvitationInvalidError({ detail: why });
  }

  /**
   * The tenant a lifecycle route names, or its 404 — the one whose action says the data is gone when the purge
   * erased it. A 404 and never a 403, for the reason `operatorOrganization` gives.
   */
  async function lifecycleOrganization(c: Ctx, organizationId: string): Promise<Organization> {
    const found = await findOrganization(db(c), organizationId);
    if (!found) throw await absent(db(c), organizationId);
    return found;
  }

  /** The organization transitions' dependencies, for this request. */
  function lifecycle(c: Ctx): OrganizationLifecycleDeps {
    return {
      db: db(c),
      d1: d1(c),
      hooks: options.lifecycleHooks ?? {},
      log: c.var.log?.child("organization"),
      now: options.now,
    };
  }

  /** The restore route a refusal names, for a tenant that is deleted. */
  const restoreRoute = (organizationId: string) => `POST ${base}/admin/organizations/${organizationId}/restore`;

  /**
   * The composed auth's lifecycle wiring, or the refusal for a Worker that has none. A cascade's write and its
   * preview both ask, so a preview is refused exactly where the write would be (#813).
   */
  function userLifecycle(): UserLifecycleWiring {
    const wiring = options.userLifecycle?.();
    if (!wiring) {
      throw new InternalError({
        message: "This Worker cannot reach a member's account, so the cascade could not run.",
        action: "Compose `auth(...)` beside `organization(...)` in this Worker.",
        detail: "a member cascade ran with no user lifecycle wired from the composed auth capability",
      });
    }
    return wiring;
  }

  /**
   * What a member cascade runs through: `@pithy-sh/auth`'s own transitions, configured as the composed auth is,
   * with the operator as the actor and the tenant and connection on every audit event they write.
   */
  function cascadeDeps(c: Ctx, organizationId: string) {
    const wiring = userLifecycle();
    const caller = operator(c);
    const enqueue = mailer(c);
    const users: LifecycleDeps = {
      db: auth(c),
      d1: d1(c),
      emit: c.var.emit,
      config: wiring.config,
      hooks: wiring.hooks,
      enqueueEmail: enqueue
        ? (input) =>
            enqueue({
              to: input.to,
              template: input.template,
              payload: input.payload,
              ...(input.locale ? { locale: input.locale } : {}),
            })
        : undefined,
      log: c.var.log?.child("organization"),
      now: options.now,
      context: {
        ...correlation(c.req.raw.headers),
        requestId: c.req.header("cf-ray") ?? undefined,
        metadata: { connectionId: caller.connectionId, organizationId },
      },
    };
    return { db: db(c), users, actor: { type: "control-plane", id: caller.subject } as const, now: clock() };
  }

  /**
   * Who the lifecycle notices go to: the account's owners — the role a transfer confers, where the project wires
   * one, or else whoever holds the power to delete it — read through auth's own reader. `except` names owners to
   * leave out: those a cascade reached, whose own account's notice already told them, and whom the organization's
   * notice would tell their account is unaffected.
   */
  async function ownerRecipients(
    c: Ctx,
    organizationId: string,
    except: ReadonlySet<string> = new Set(),
  ): Promise<NoticeRecipient[]> {
    const rows = await db(c)
      .selectFrom(MEMBERSHIPS_TABLE)
      .select(["userId", "role"])
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "asc")
      .execute();
    const owning = rows.filter(
      (row) =>
        !except.has(row.userId) &&
        (options.ownership
          ? row.role === options.ownership.confers
          : catalog.Role.safeParse(row.role).success && catalog.roleAllows(row.role as Role, "organization:delete")),
    );
    const people = await readPeople(
      auth(c),
      owning.map((row) => row.userId),
    );
    return owning.flatMap((row) => {
      const person = people.get(row.userId);
      return person ? [{ email: person.email, name: person.name, locale: person.locale ?? null }] : [];
    });
  }

  /** How many members a cascade reached and skipped — counts for the trail, never the people. */
  const cascadeFacts = (members: CascadeOutcome) => ({
    members: members.mode,
    reached: members.reached.length,
    skipped: members.skipped.length,
  });

  /**
   * Start one organization's purge now: `started` when this Worker binds the purge Workflow and it took the
   * instance, `pending` when it binds none or the start failed — the organization is due either way, and the
   * daily pass starts it. A failed start is not this call's failure: the deletion is already written.
   */
  async function startOrganizationPurge(
    c: Ctx,
    organizationId: string,
    deletedAt: Date,
  ): Promise<"started" | "pending"> {
    const log = c.var.log?.child("organization");
    const bound = workflowBindingFor(c.env as Record<string, unknown>, ORGANIZATION_PURGE_BINDING);
    if (!bound) {
      log?.warn("a deletion found no organization purge Workflow bound; the purge is pending", { organizationId });
      return "pending";
    }
    try {
      await startOrganizationPurgeInstance(bound, { organizationId, deletedAt: deletedAt.getTime(), at: new Date() });
      return "started";
    } catch (error) {
      log?.warn("the organization purge could not be started; the daily pass will start it", {
        organizationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return "pending";
    }
  }

  /**
   * Start one member's account purge after a hard cascade deleted it, best effort: the account is due either way,
   * and auth's own daily pass starts whatever this could not.
   */
  async function startMemberPurge(c: Ctx, userId: string, deletedAt: Date): Promise<void> {
    const bound = workflowBindingFor(c.env as Record<string, unknown>, AUTH_PURGE_BINDING);
    if (!bound) return;
    try {
      await startPurgeInstance(bound, { userId, deletedAt: deletedAt.getTime(), at: new Date() });
    } catch (error) {
      c.var.log?.child("organization").warn("a member's purge could not be started; auth's daily pass will start it", {
        userId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (backend) => {
    const app = backend as unknown as Hono<Env>;

    /*
      **Interesting refusals reach the trail, and this is the one place they do.**

      `audit/emit.ts` argues that a refusal is worth recording where the refusal *is* the interesting
      event — the last administrator somebody tried to remove, an invitation redeemed by the wrong
      address — and that neither leaves a row if only successes are written. Nothing emitted one. A
      `try`/`catch` per handler would have been twenty-odd chances to forget, so it is middleware over
      the whole surface: every route this capability mounts passes through it, including the ones added
      after this comment.

      **Only refusals of somebody already inside.** `organization/not_found` is excluded and that
      exclusion is the design rather than an omission: it is the answer to both "no such organization"
      and "not one of yours", so it is the refusal a stranger can produce at will by naming a UUID.
      Recording it would hand whoever is probing the ability to write this trail, and a real event buried
      under a sweep of their noise is the failure the register exists to avoid.

      **The error is re-thrown unchanged.** This observes; `pithyErrorHandler` still renders, and a
      caller's answer is byte-for-byte what it was — which matters most for the one refusal that is
      deliberately indistinguishable from another.
    */
    app.use(`${base}/*`, async (c, next) => {
      try {
        await next();
      } catch (error) {
        // A throw that reached here rather than Hono's own handling — a middleware above `onError`, or
        // an app that registered none.
        await recordRefusal(c, error);
        throw error;
      }
      /*
        **And the ordinary path, which is `c.error` rather than a rejection.** Hono's `compose` catches a
        downstream throw, renders it through `app.onError`, and resolves `next()` — so a `try`/`catch`
        here sees nothing at all on the route stack an adopter actually composes. That is not a detail to
        leave to memory: the first version of this was a bare `try`/`catch`, it looked right, and it
        recorded exactly zero refusals while every test around it passed.
      */
      await recordRefusal(c, c.error);
    });

    // ── the chooser's two routes: what the caller may act in, and what they act in ──────────────

    app.get(
      base,
      describeRoute({
        summary: "List the organizations the caller may act in.",
        verification: signedIn,
        responses: { 200: OrganizationsResponse },
      }),
      requireAuth<Role>(),
      async (c) => {
        const who = session(c);
        const database = db(c);
        // The membership join is the entitlement; the second read is only the rows it named. An
        // organization list built the other way round would be every tenant in the database, filtered.
        const now = clock();
        const actable = await listActable(database, catalog, who.userId, now);
        // Read without refusing: a selection naming an organization since suspended is cleared, and the list
        // still answers — without it, and with nothing in force (#623).
        const selection = await resolveSelection(database, catalog, { ...who, now });
        const acting = selection?.kind === "acting" ? selection.acting : null;
        const rows = await readOrganizations(
          database,
          actable.map((membership) => membership.organizationId),
        );
        return c.json({
          organizations: actable.flatMap((membership) => {
            const organization = rows.get(membership.organizationId);
            return organization ? [organizationView(organization, membership.role, base)] : [];
          }),
          acting: acting?.organizationId ?? null,
          chosen: acting?.chosen ?? false,
          suspended: await countSuspended(database, who.userId, now),
        } satisfies OrganizationsResponse);
      },
    );

    /**
     * Found an organization.
     *
     * **Refused for everybody when `allowSelfService` is false**, rather than gated on a power nobody
     * holds. There is no organization in force yet and therefore no role to read, so the only honest
     * shape of that setting is a route that says no to every caller — including the operator, who
     * provisions through their own code with an actor they can name.
     *
     * It does **not** move the acting selection. Creating a second account from a settings pane must not
     * silently move somebody out of the one they were working in; the client chooses the new account with
     * `POST {base}/acting` when that is what the person meant.
     */
    app.post(
      base,
      describeRoute({
        summary: "Found an organization.",
        description: "Refused for every caller while `allowSelfService` is off. Does not move the acting selection.",
        verification: signedIn,
        responses: { 201: OrganizationResponse },
      }),
      csrf,
      requireAuth<Role>(),
      validate("json", createOrganizationBody(config.slugs)),
      async (c) => {
        if (!config.allowSelfService) {
          throw new OrganizationForbiddenError({
            message: "Organizations are created by the operator here.",
            action: "Ask for one to be created.",
            detail: "allowSelfService is false, so this route refuses every caller",
          });
        }
        const who = session(c);
        const body = c.req.valid("json");
        const created = await createOrganization(d1(c), catalog, {
          name: body.name,
          slug: body.slug,
          founderUserId: who.userId,
          now: clock(),
          newId: ids,
        });
        await record(c, {
          action: OrganizationAuditActions.created,
          actor: { organizationId: created.organization.id, userId: who.userId },
          resource: { type: "organization", id: created.organization.id },
          // `derived` and not merely the slug: a chosen short name is a string a caller put into an
          // account's facts, and a derived one is ours. A row that read the same either way could not
          // answer which.
          // The membership and its holder too (#831): the founding is the account's first membership, and the access
          // history reads it as a join.
          facts: {
            slug: created.organization.slug,
            role: created.membership.role,
            derived: body.slug === undefined,
            membershipId: created.membership.id,
            subjectUserId: who.userId,
          },
        });
        return c.json(
          {
            organization: organizationView(created.organization, created.membership.role, base),
          } satisfies OrganizationResponse,
          201,
        );
      },
    );

    /**
     * Choose the organization this session acts in.
     *
     * The membership is proved inside `chooseActing`, in the predicate that names both halves, and an
     * account the caller is not in refuses with the same 404 as one that does not exist. The answer is
     * read back off the row the write left rather than echoed from the request — a client re-rendering
     * from what it sent is rendering what it asked for, and the two differ exactly when something refused.
     */
    app.post(
      `${base}/acting`,
      describeRoute({
        summary: "Choose the organization this session acts in.",
        verification: signedIn,
        responses: { 200: ActingResponse },
      }),
      csrf,
      requireAuth<Role>(),
      validate("json", ChooseOrganization),
      async (c) => {
        const who = session(c);
        const database = db(c);
        const now = clock();
        await chooseActing(database, { ...who, organizationId: c.req.valid("json").organizationId, now });
        const acting = await resolveActing(database, catalog, { ...who, now });
        if (!acting) {
          // The membership went between the proof and the read. Same 404 as every other absence.
          throw noSuchOrganization(
            `selection for user ${who.userId} resolved to no membership immediately after it was written`,
          );
        }
        return c.json(actingView(acting));
      },
    );

    // ── the account in force ───────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current`,
      describeRoute({
        summary: "Read the organization in force.",
        description: "Requires the `organization:read` power in the acting organization.",
        verification: signedIn,
        responses: { 200: OrganizationRecordResponse },
      }),
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      async (c) => {
        const acting = c.var.acting;
        const database = db(c);
        const organization = await readOrganization(database, acting.organizationId);
        // Null rather than zero for somebody who cannot manage the account: who has been asked and has
        // not answered is of no use to a reader who can neither withdraw an offer nor resend one, and a
        // zero would be this record answering a question it declined to read.
        const mayManage = catalog.roleAllows(acting.role, "organization:manage");
        return c.json({
          organization: organizationView(organization, acting.role, base),
          totals: {
            members: await countRows(database, MEMBERSHIPS_TABLE, acting.organizationId),
            invitations: mayManage ? await countRows(database, INVITATIONS_TABLE, acting.organizationId, true) : null,
          },
        } satisfies OrganizationRecordResponse);
      },
    );

    /**
     * Rename the account, set its mark, or take the mark off.
     *
     * Two writers rather than one, because absent and `null` are different instructions and a single
     * `set` built by spreading the body would collapse them — writing `logo = NULL` for a rename that
     * never mentioned it. They are audited separately for the same reason: folding a mark change into a
     * rename would put a lie in an append-only table.
     */
    app.patch(
      `${base}/current`,
      describeRoute({
        summary: "Rename the organization, or set or clear its mark.",
        description: "Requires the `organization:manage` power in the acting organization.",
        verification: signedIn,
        responses: { 200: OrganizationResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("json", UpdateOrganization),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const body = c.req.valid("json");
        const now = clock();
        const actor = { organizationId: acting.organizationId, userId: who.userId };
        const resource = { type: "organization", id: acting.organizationId } as const;

        if (body.name !== undefined) {
          await renameOrganization(d1(c), { organizationId: acting.organizationId, name: body.name, now });
          // The new name, never the old one — a trail that kept both would be a history of what every
          // tenant used to call itself, held forever for a question nobody asks.
          await record(c, { action: OrganizationAuditActions.renamed, actor, resource, facts: { name: body.name } });
        }
        if (body.logo !== undefined) {
          await setLogo(d1(c), { organizationId: acting.organizationId, logo: body.logo, now });
          // Whether there is one now, never the bytes.
          await record(c, {
            action: OrganizationAuditActions.logoChanged,
            actor,
            resource,
            facts: { cleared: body.logo === null },
          });
        }
        const organization = await readOrganization(db(c), acting.organizationId);
        return c.json({
          organization: organizationView(organization, acting.role, base),
        } satisfies OrganizationResponse);
      },
    );

    app.delete(
      `${base}/current`,
      describeRoute({
        summary: "Delete the organization in force.",
        description: "Requires the `organization:delete` power in the acting organization.",
        verification: signedIn,
        responses: { 200: DeletedOrganizationResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:delete", deps),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        // The adopter's own tenanted rows go in the same transaction — `#570`.
        await deleteOrganization(d1(c), acting.organizationId, options.onDelete);
        // Recorded against the account that no longer exists, which is the only record that it ever did.
        await record(c, {
          action: OrganizationAuditActions.deleted,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "organization", id: acting.organizationId },
          severity: "warning",
        });
        return c.json({ organizationId: acting.organizationId } satisfies DeletedOrganizationResponse);
      },
    );

    // ── the roster ─────────────────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current/members`,
      describeRoute({
        summary: "List the members of the organization in force.",
        description: "Requires the `organization:read` power in the acting organization.",
        verification: signedIn,
        responses: { 200: MembersResponse },
      }),
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      async (c) => {
        const acting = c.var.acting;
        const memberships = await listMembers(db(c), acting.organizationId);
        // Through the auth capability's own published reader, never a join written here —
        // `pithy_auth_accounts` sits beside that table holding live provider credentials.
        const people = await readPeople(
          auth(c),
          memberships.map((membership) => membership.userId),
        );
        return c.json({
          members: memberships.map((membership) => memberView(membership, people.get(membership.userId), base)),
        } satisfies MembersResponse);
      },
    );

    app.patch(
      `${base}/current/members/:membershipId`,
      describeRoute({
        summary: "Change a member's role.",
        description:
          "Requires the `organization:manage` power in the acting organization, and `members:manage` to assign a role that administers.",
        verification: signedIn,
        responses: { 200: MemberRoleResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("param", MembershipParam),
      validate("json", ChangeRole),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        // `changeRole` spends `requireMayAssign` itself, which is what makes the rule one function both
        // this door and the invitation below call rather than two copies that can disagree.
        const changed = await changeRole(db(c), catalog, {
          organizationId: acting.organizationId,
          membershipId: c.req.valid("param").membershipId,
          role: c.req.valid("json").role,
          actor: acting,
        });
        await record(c, {
          action: OrganizationAuditActions.memberRoleChanged,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: changed.id },
          // The before beside the after (#831), so the change can be replayed without a guess.
          facts: { role: changed.role, previousRole: changed.previousRole, subjectUserId: changed.userId },
        });
        return c.json({ member: membershipView(changed) } satisfies MemberRoleResponse);
      },
    );

    app.delete(
      `${base}/current/members/:membershipId`,
      describeRoute({
        summary: "Remove a member.",
        description: "Requires the `organization:manage` power in the acting organization.",
        verification: signedIn,
        responses: { 200: RemovedMemberResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("param", MembershipParam),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const removed = await removeMember(d1(c), catalog, {
          organizationId: acting.organizationId,
          membershipId: c.req.valid("param").membershipId,
          actor: acting,
        });
        await record(c, {
          // Two codes, because a removal and a leaving are two events with two subjects. Naming a member
          // removed when they walked out is a sentence somebody reads a fortnight later and believes.
          action: removed.left ? OrganizationAuditActions.memberLeft : OrganizationAuditActions.memberRemoved,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: removed.membership.id },
          facts: { role: removed.membership.role, subjectUserId: removed.membership.userId },
        });
        return c.json({
          membershipId: removed.membership.id,
          left: removed.left,
        } satisfies RemovedMemberResponse);
      },
    );

    /**
     * Leave the organization in force.
     *
     * **No power, and no membership id.** You leave an account; you do not name a row. The floor still
     * applies — walking out as the last administrator leaves exactly the account nobody can repair that
     * the invariant exists to prevent — and so does the unassignable-role rule, so the holder of a role
     * that arrived by transfer has no exit that is not another transfer.
     */
    app.post(
      `${base}/current/members/leave`,
      describeRoute({
        summary: "Leave the organization in force.",
        description: "The last administrator cannot leave.",
        verification: signedIn,
        responses: { 200: RemovedMemberResponse },
      }),
      csrf,
      requireOrganization(deps),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const removed = await leaveOrganization(d1(c), catalog, {
          organizationId: acting.organizationId,
          actor: acting,
        });
        await record(c, {
          action: OrganizationAuditActions.memberLeft,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: removed.membership.id },
          // The member is named on every member event (#831), even where they are also the actor.
          facts: { role: removed.membership.role, subjectUserId: who.userId },
        });
        return c.json({ membershipId: removed.membership.id, left: true } satisfies RemovedMemberResponse);
      },
    );

    // ── invitations ────────────────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current/invitations`,
      describeRoute({
        summary: "List the outstanding invitations.",
        description: "Requires the `organization:manage` power in the acting organization.",
        verification: signedIn,
        responses: { 200: InvitationsResponse },
      }),
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      async (c) => {
        const invitations = await listInvitations(db(c), c.var.acting.organizationId);
        return c.json({ invitations: invitations.map(invitationView) } satisfies InvitationsResponse);
      },
    );

    /**
     * Offer membership to an address.
     *
     * **Both gates are spent before a row is written, and one of them is not the route's own.**
     * `organization:manage` runs the roster; handing somebody a role that *administers* additionally
     * takes `members:manage`, and that is `requireMayAssign` from `../members/members.ts` — the same
     * function `changeRole` calls, because an invitation offering an administering role is a promotion
     * arriving by the other door. A rule checked in one of the two is a rule with a second door.
     *
     * **The mail seam and the origin are resolved before the offer is minted.** An invitation written and
     * then not sent is a live token nobody receives and nobody can withdraw from a list they never saw.
     */
    app.post(
      `${base}/current/invitations`,
      describeRoute({
        summary: "Invite somebody by address.",
        description:
          "Requires the `organization:manage` power in the acting organization, and `members:manage` to offer a role that administers.",
        verification: signedIn,
        responses: { 201: InviteResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("json", InviteMember),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const body = c.req.valid("json");
        const database = db(c);
        const now = clock();

        // Only when the catalog knows the name. An unknown or excluded role is `invite()`'s refusal to
        // make — it owns the assignable set — and `requireMayAssign` takes a declared role.
        const assigned = catalog.AssignableRole.safeParse(body.role);
        if (assigned.success) requireMayAssign(catalog, acting.role, assigned.data as Role);

        const enqueue = config.sendInvitationEmail ? options.enqueue?.(c.env as Record<string, unknown>) : undefined;
        if (config.sendInvitationEmail && !enqueue) {
          throw new InternalError({
            message: "That invitation could not be sent.",
            action: "Add `email(...)` to this Worker's capabilities, or set `sendInvitationEmail: false`.",
            detail: "sendInvitationEmail is true and no email capability published an enqueue seam",
          });
        }
        // Proves the origin is configured **before** a row is written. The value is thrown away; what is
        // wanted is the refusal `invitationAcceptUrl` raises when `baseUrl` is unset, raised at the moment
        // nothing has been minted yet rather than one statement later with an unsendable offer on disk.
        invitationAcceptUrl(config, "preflight");

        // The binding, not the database: superseding and minting are one transaction — `invite()` says why.
        const minted = await invite(d1(c), catalog, {
          organizationId: acting.organizationId,
          email: body.email,
          role: body.role as Role,
          invitedByUserId: who.userId,
          ttlDays: config.invitationTtlDays,
          now,
          newId: ids,
        });
        const acceptUrl = invitationAcceptUrl(config, minted.token);

        let sent: string | null = null;
        if (enqueue) {
          const organization = await readOrganization(database, acting.organizationId);
          const inviter = (await readPeople(auth(c), [who.userId])).get(who.userId);
          const result = await sendInvitationMail(enqueue, {
            to: minted.invitation.email,
            organizationName: organization.name,
            inviterName: inviter?.name?.trim() || "Somebody",
            acceptUrl,
          });
          sent = result.status;
        }

        // The role and the offer's id. **Never the address and never the token** — the trail is
        // append-only and nobody prunes it, which is the opposite rule from the roster beside it.
        await record(c, {
          action: OrganizationAuditActions.memberInvited,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: minted.invitation.id },
          facts: { role: minted.invitation.role, mailed: sent },
        });

        return c.json(
          {
            invitation: invitationView(minted.invitation),
            // The link leaves the Worker only where nobody else is going to send it. When the capability
            // mailed it, the token is in the mail and in no response body, which is the whole point of
            // putting it there.
            acceptUrl: enqueue ? null : acceptUrl,
          } satisfies InviteResponse,
          201,
        );
      },
    );

    /**
     * Send an invitation again.
     *
     * **`requireMayAssign` is spent a second time here, and that is not belt-and-braces.** A resend
     * revives an offer of a role, so it is the same act as making it: a member promoted to administrator
     * between the first send and the resend must not be able to re-offer an administering role they
     * could no longer grant. The role is read off the stored row rather than off the request, so what is
     * re-offered is what was offered.
     *
     * The old link stops working in the same write — one live token per offer — which is why this is a
     * mutation rather than a second GET of the same thing.
     */
    app.post(
      `${base}/current/invitations/:invitationId/resend`,
      describeRoute({
        summary: "Send an invitation again, with a new link.",
        description:
          "Requires the `organization:manage` power in the acting organization, and `members:manage` when the offered role administers. The old link stops working.",
        verification: signedIn,
        responses: { 200: InviteResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("param", InvitationParam),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const database = db(c);

        const enqueue = config.sendInvitationEmail ? options.enqueue?.(c.env as Record<string, unknown>) : undefined;
        if (config.sendInvitationEmail && !enqueue) {
          throw new InternalError({
            message: "That invitation could not be sent.",
            action: "Add `email(...)` to this Worker's capabilities, or set `sendInvitationEmail: false`.",
            detail: "sendInvitationEmail is true and no email capability published an enqueue seam",
          });
        }
        // Before anything is written, as on the send path and for the same reason.
        invitationAcceptUrl(config, "preflight");

        const existing = await requireInvitationInOrganization(
          database,
          acting.organizationId,
          c.req.valid("param").invitationId,
        );
        /*
          Off the row, never the request. The standing to re-offer is checked against what the offer
          says, so a caller cannot widen it by resending.

          **And a role the catalog no longer assigns is refused outright rather than waved through.** The
          same `if (success)` shape on the send route above is safe because `invite()` refuses an
          unassignable role itself; `resendInvitation` inspects no role at all, so here the conditional
          would be the only guard — and it would be skipped precisely where the rule is strictest. A
          pending offer of a role the project has since reserved is dead, not renewable, and the refusal
          is the ordinary one so a caller learns nothing about the catalog from it.
        */
        const offered = catalog.AssignableRole.safeParse(existing.role);
        if (!offered.success) {
          throw offerInvalid(
            `invitation ${existing.id} offers role ${JSON.stringify(existing.role)}, which this catalog no longer assigns`,
          );
        }
        requireMayAssign(catalog, acting.role, offered.data as Role);

        const minted = await resendInvitation(database, {
          organizationId: acting.organizationId,
          invitationId: existing.id,
          ttlDays: config.invitationTtlDays,
          now: clock(),
        });
        const acceptUrl = invitationAcceptUrl(config, minted.token);

        let sent: string | null = null;
        if (enqueue) {
          const organization = await readOrganization(database, acting.organizationId);
          const inviter = (await readPeople(auth(c), [who.userId])).get(who.userId);
          const result = await sendInvitationMail(enqueue, {
            to: minted.invitation.email,
            organizationName: organization.name,
            inviterName: inviter?.name?.trim() || "Somebody",
            acceptUrl,
          });
          sent = result.status;
        }

        await record(c, {
          action: OrganizationAuditActions.invitationResent,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: minted.invitation.id },
          facts: { role: minted.invitation.role, mailed: sent },
        });

        return c.json({
          invitation: invitationView(minted.invitation),
          acceptUrl: enqueue ? null : acceptUrl,
        } satisfies InviteResponse);
      },
    );

    app.delete(
      `${base}/current/invitations/:invitationId`,
      describeRoute({
        summary: "Withdraw an invitation.",
        description: "Requires the `organization:manage` power in the acting organization.",
        verification: signedIn,
        responses: { 200: WithdrawnInvitationResponse },
      }),
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      validate("param", InvitationParam),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const invitation = await withdrawInvitation(db(c), {
          organizationId: acting.organizationId,
          invitationId: c.req.valid("param").invitationId,
          now: clock(),
        });
        await record(c, {
          action: OrganizationAuditActions.invitationRevoked,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: invitation.id },
          facts: { role: invitation.role },
        });
        return c.json({ invitation: invitationView(invitation) } satisfies WithdrawnInvitationResponse);
      },
    );

    /**
     * What an accept screen renders, for somebody holding a link and nothing else.
     *
     * **Public, and it grants nothing.** `invitationAcceptUrl` mints `{base}/invitations/{token}` because
     * an email cannot post, so this is the URL in every invitation already sent — and a route that did
     * not exist would make that link a 404 for the one person it was written for. What it answers is the
     * three facts a person needs in order to decide; the membership is still written only by the POST
     * below, which carries the token where a referrer header cannot reach it.
     *
     * Every refusal is the same sentence — unknown token, spent, withdrawn, expired, an account since
     * deleted — because telling somebody which it was tells whoever a link was forwarded to the same
     * thing.
     */
    app.get(
      `${base}/invitations/:token`,
      describeRoute({
        summary: "Read what an invitation link offers.",
        description: "Grants nothing. Every refusal is the same answer.",
        verification: "public",
        responses: { 200: InvitationOfferResponse },
      }),
      validate("param", InvitationTokenParam),
      async (c) => {
        const database = db(c);
        const now = clock();
        // Matched by digest, never by the token as it arrived: a read of that table must not yield
        // something that can be redeemed.
        const row = await database
          .selectFrom(INVITATIONS_TABLE)
          .selectAll()
          .where("tokenDigest", "=", await invitationDigest(c.req.valid("param").token))
          .executeTakeFirst();
        if (!row) throw offerInvalid("no invitation matches the presented token digest");
        const invitation = Invitation.parse(row);
        if (invitation.status !== "pending") throw offerInvalid(`invitation ${invitation.id} is ${invitation.status}`);
        if (invitation.expiresAt <= now) {
          throw offerInvalid(`invitation ${invitation.id} expired at ${invitation.expiresAt.toISOString()}`);
        }
        const organization = await findOrganization(database, invitation.organizationId);
        if (!organization) {
          throw offerInvalid(`organization ${invitation.organizationId} no longer exists`);
        }
        // A suspended or deleted organization offers nothing (#623): `acceptInvitation` refuses the join, so the
        // accept screen must not show an offer it cannot honor — nor the name and inviter of a shut tenant.
        const standing = organizationStanding(organization, now);
        if (standing.state !== "active") {
          throw offerInvalid(`organization ${invitation.organizationId} is ${standing.state}`);
        }
        const inviter = (await readPeople(auth(c), [invitation.invitedByUserId])).get(invitation.invitedByUserId);
        return c.json(invitationOfferView(invitation, organization.name, inviter));
      },
    );

    /**
     * Redeem an offer.
     *
     * **No `requireOrganization()`, deliberately.** The caller is not in the account yet — that is what
     * they are here to change — so a gate proving a membership would refuse every legitimate use.
     *
     * The authorization is the address: the accepting session's own, compared against the invited one.
     * It is read from `pithy_auth_users` rather than taken from the request, because a body that named
     * the address it was being matched against would be the caller answering their own question.
     */
    app.post(
      `${base}/invitations/accept`,
      describeRoute({
        summary: "Accept an invitation.",
        description: "The signed-in address must match the invited one. Does not move the acting selection.",
        verification: signedIn,
        responses: { 200: AcceptInvitationResponse },
      }),
      csrf,
      requireAuth<Role>(),
      validate("json", AcceptInvitation),
      async (c) => {
        const who = session(c);
        const me = (await readPeople(auth(c), [who.userId])).get(who.userId);
        if (!me) {
          // No address to compare, so nothing to authorize. The same sentence as every other refusal.
          throw offerInvalid(`no user row for ${who.userId}; an invitation is redeemed by address and there is none`);
        }
        const accepted = await acceptInvitation(d1(c), catalog, {
          token: c.req.valid("json").token,
          session: { userId: who.userId, email: me.email },
          now: clock(),
          newId: ids,
        });
        await record(c, {
          action: OrganizationAuditActions.memberJoined,
          actor: { organizationId: accepted.invitation.organizationId, userId: who.userId },
          resource: { type: "membership", id: accepted.membershipId },
          facts: {
            role: accepted.role,
            invitationId: accepted.invitation.id,
            joined: accepted.joined,
            subjectUserId: who.userId,
          },
        });
        return c.json({
          organizationId: accepted.invitation.organizationId,
          membershipId: accepted.membershipId,
          role: accepted.role,
          joined: accepted.joined,
        } satisfies AcceptInvitationResponse);
      },
    );

    // ── ownership, where this project has a transfer at all ────────────────────────────────────

    const ownership = options.ownership;
    if (ownership) {
      /**
       * The account's one standing offer of ownership, or null.
       *
       * **Without this, nobody can discover through the API that they were nominated.** A nomination
       * carries no token and sends no mail — deliberately, because the nominee already holds a session
       * this account trusts — so the only way an offer reaches the person it was made to is a screen
       * that reads it. A transfer nobody can see is a transfer that never happens.
       *
       * Gated on membership alone rather than on `billing:manage`. The nominee is by definition the
       * person who does **not** hold the account yet, so a power gate here would hide the offer from
       * exactly the one caller it exists for. What it discloses is a fact about an organization the
       * caller has already been proved a member of: who was offered it, by whom, and until when.
       */
      app.get(
        `${base}/current/ownership`,
        describeRoute({
          summary: "Read the standing offer of ownership.",
          verification: signedIn,
          responses: { 200: NominationResponse },
        }),
        requireOrganization(deps),
        async (c) => {
          const nomination = await standingNomination(db(c), c.var.acting.organizationId, clock());
          return c.json({
            nomination: nomination ? nominationView(nomination) : null,
          } satisfies NominationResponse);
        },
      );

      app.post(
        `${base}/current/ownership`,
        describeRoute({
          summary: "Offer ownership of the organization to a member.",
          description:
            "Only the holder may offer it. While nobody holds it, an administrator may volunteer themselves.",
          verification: signedIn,
          responses: { 201: NominationResponse },
        }),
        csrf,
        requireOrganization(deps),
        validate("json", NominateOwner),
        async (c) => {
          const acting = c.var.acting;
          const who = session(c);
          const now = clock();
          /*
            **Membership, and then the store's own rule — deliberately no `billing:manage` here.**

            The obvious gate is the wrong one, and it closes the account permanently. In the catalog this
            kit scaffolds, `billing:manage` is held by the conferred role and by nothing else, and a new
            account has no holder of it: `provision.ts` gives the founder the first *assignable*
            administering role, and the conferred role is unassignable by definition. So gating on
            `billing:manage` narrows "anybody in the account may volunteer" to "the owner the account
            does not have" — and since `changeRole` refuses the unassignable role too, nothing can ever
            repair it.

            `nominate` already holds the real rule, and it is conditional in a way a power cannot be:
            while somebody holds the account only they hand it on, and while nobody does, somebody who
            already **administers** it may volunteer themselves and appoint nobody else. That is stronger
            than `billing:manage` where an account is held, and it is the only thing that works where it
            is not — `founderRole` is an administering role, so a fresh account always has somebody who
            can take it on.

            **The administering half was missing and it was an escalation.** "Anybody in it may
            volunteer" meant any member of any account that had never transferred, which is every account
            from the moment it is founded; two requests took a reader to `members:manage`,
            `billing:manage` and `organization:delete`, irreversibly, because the conferred role is
            unassignable and so cannot be demoted, removed or left. The rule lives in `nominate` rather
            than as middleware here so that an adopter calling the store directly gets it too.
          */
          const nomination = await nominate(db(c), catalog, {
            organizationId: acting.organizationId,
            membershipId: c.req.valid("json").membershipId,
            nominatedByUserId: who.userId,
            expiresAt: new Date(now.getTime() + config.nominationTtlDays * DAY_MS),
            roles: ownership,
            now,
          });
          await record(c, {
            action: OrganizationAuditActions.ownershipNominated,
            actor: { organizationId: acting.organizationId, userId: who.userId },
            resource: { type: "membership", id: nomination.membershipId },
            facts: { confers: ownership.confers },
          });
          return c.json({ nomination: nominationView(nomination) } satisfies NominationResponse, 201);
        },
      );

      app.delete(
        `${base}/current/ownership`,
        describeRoute({
          summary: "Withdraw the standing offer of ownership.",
          verification: signedIn,
          responses: { 200: NominationResponse },
        }),
        csrf,
        requireOrganization(deps),
        // Membership, and then the store's rule — the same correction the nominate route above carries,
        // for the same reason. A `billing:manage` gate here would stop an unheld account's volunteer
        // taking back their own offer, because nobody holds the power that would let them.
        async (c) => {
          const acting = c.var.acting;
          const who = session(c);
          const withdrawn = await withdrawNomination(db(c), {
            organizationId: acting.organizationId,
            userId: who.userId,
            roles: ownership,
          });
          // Only when there was one. Recording a withdrawal of nothing would put an act in the trail that
          // nobody took, and the answer to the caller is the same either way — there is no offer now.
          if (withdrawn) {
            await record(c, {
              action: OrganizationAuditActions.ownershipWithdrawn,
              actor: { organizationId: acting.organizationId, userId: who.userId },
              resource: { type: "organization", id: acting.organizationId },
            });
          }
          return c.json({ nomination: null } satisfies NominationResponse);
        },
      );

      /**
       * Accept the account.
       *
       * **No power.** Being the nominee is the entitlement, and `acceptNomination` proves it against the
       * standing offer — a caller holding every power in the catalog cannot accept an offer made to
       * somebody else, which is the whole of what makes the transfer two-party.
       */
      app.post(
        `${base}/ownership/accept`,
        describeRoute({
          summary: "Accept ownership of the organization.",
          description: "Only the nominee may accept.",
          verification: signedIn,
          responses: { 200: TransferResponse },
        }),
        csrf,
        requireOrganization(deps),
        async (c) => {
          const acting = c.var.acting;
          const who = session(c);
          const transfer = await acceptNomination(d1(c), catalog, {
            organizationId: acting.organizationId,
            userId: who.userId,
            now: clock(),
            roles: ownership,
          });
          await record(c, {
            action: OrganizationAuditActions.ownershipAccepted,
            actor: { organizationId: acting.organizationId, userId: who.userId },
            resource: { type: "membership", id: transfer.newHolderMembershipId },
            // It succeeded, and a reader scanning for what went quiet before an incident should find the
            // account changing hands above the routine.
            severity: "warning",
            facts: {
              confers: ownership.confers,
              demoted: transfer.previousHolderMembershipIds.length,
              // The new holder's before and after (#831).
              role: ownership.confers,
              previousRole: transfer.previousRole,
              subjectUserId: who.userId,
            },
          });
          /*
            **Each demoted holder gets an event of their own**, as the forced path records them (#831). A fact
            cannot be a list, so without these the trail would hold a count and never say whose role the
            acceptance took away.
          */
          for (const holder of transfer.previousHolders) {
            await record(c, {
              action: OrganizationAuditActions.memberRoleChanged,
              actor: { organizationId: acting.organizationId, userId: who.userId },
              resource: { type: "membership", id: holder.id },
              facts: {
                role: ownership.demotesTo,
                previousRole: ownership.confers,
                subjectUserId: holder.userId,
                ownershipTo: transfer.newHolderMembershipId,
              },
            });
          }
          return c.json({
            newHolderMembershipId: transfer.newHolderMembershipId,
            previousHolderMembershipIds: [...transfer.previousHolderMembershipIds],
          } satisfies TransferResponse);
        },
      );
    }

    // ── marks ─────────────────────────────────────────────────────────────────────────────────

    /**
     * An organization's mark.
     *
     * **Named in the path, and gated by membership in the organization it names** — not by the acting
     * selection, because this is drawn on the chooser, where nothing is in force yet and the caller may
     * belong to three accounts at once. The validator sits above the gate because the gate reads the id
     * back through `c.req.valid("param")`; nothing leaks, since the only thing a caller learns from the
     * 400 is whether what they typed was a UUID.
     */
    app.get(
      `${base}${MARKS_SEGMENT}/organization/:organizationId`,
      describeRoute({
        summary: "Read an organization's mark.",
        description: "Requires membership in the organization named.",
        verification: signedIn,
        responses: { 200: RASTER_MARK },
      }),
      requireAuth<Role>(),
      validate("param", OrganizationMarkParam),
      requireOrganization(deps, { from: "param", name: "organizationId" }),
      async (c) => {
        const organization = await readOrganization(db(c), c.var.acting.organizationId);
        return serveMark(organization.logo, `organization ${organization.id} has no raster mark to serve`);
      },
    );

    /**
     * A member's face.
     *
     * **Keyed by the membership, and resolved inside the acting organization** — so entitlement is the
     * roster the face is already drawn on, and a membership id from another account is the same 404 as
     * one that never existed. There is no arrangement of this path that asks whether a given *user* id is
     * real, which is the question `@pithy-sh/auth` declines to answer by serving only the caller's own.
     */
    app.get(
      `${base}${MEMBERS_PATH_SEGMENT}/:membershipId/image`,
      describeRoute({
        summary: "Read a member's face.",
        description: "Requires the `organization:read` power in the acting organization.",
        verification: signedIn,
        responses: { 200: RASTER_MARK },
      }),
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      validate("param", MemberMarkParam),
      async (c) => {
        const acting = c.var.acting;
        const database = db(c);
        const target = await requireMembershipInOrganization(
          database,
          catalog,
          acting.organizationId,
          c.req.valid("param").membershipId,
        );
        const person = (await readPeople(auth(c), [target.userId])).get(target.userId);
        // Null for a provider's link as well as for a vector: that URL is already somewhere else, and
        // `memberView` hands the client it directly rather than this path.
        return serveMark(person?.image ?? null, `membership ${target.id} has no raster face to serve`);
      },
    );

    // ── the management surface: two reads ──────────────────────────────────────────────────────

    app.get(
      `${base}/admin/organizations`,
      describeRoute({
        summary: "List the tenants.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_READ_SCOPE],
        responses: { 200: AdminOrganizationsResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_READ_SCOPE),
      validate("query", AdminListQuery),
      async (c) => {
        const database = db(c);
        const limit = c.req.valid("query").limit ?? MAX_PAGE_SIZE;
        // One past the bound, so the flag is a fact rather than an inference from a full page.
        const rows = await database
          .selectFrom(ORGANIZATIONS_TABLE)
          .selectAll()
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit).map((row) => Organization.parse(row));
        const counts = await memberCounts(
          database,
          page.map((organization) => organization.id),
        );
        return c.json({
          organizations: page.map((organization) =>
            adminOrganizationView(organization, counts.get(organization.id) ?? 0, clock()),
          ),
          truncated: rows.length > limit,
        } satisfies AdminOrganizationsResponse);
      },
    );

    app.get(
      `${base}/admin/organizations/:organizationId/members`,
      describeRoute({
        summary: "List one tenant's members.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_READ_SCOPE],
        responses: { 200: AdminMembersResponse },
      }),
      gate(ORGANIZATION_MEMBERS_READ_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("query", AdminListQuery),
      async (c) => {
        const limit = c.req.valid("query").limit ?? MAX_PAGE_SIZE;
        // An account that does not exist is a 404, not an empty roster: "nobody is in it" and "there is no
        // it" are two answers, and a support pane that rendered the first for a typo'd id would send
        // somebody looking for people who were never there.
        await operatorOrganization(c, c.req.valid("param").organizationId);
        // The limit goes to the statement, the way the accounts listing above does it. One row past the
        // bound comes back, so `truncated` is a fact the page carries rather than an inference from a
        // full one — and D1 is never asked for a whole tenant's roster to throw most of it away.
        const memberships = await listMembers(db(c), c.req.valid("param").organizationId, limit);
        const page = memberships.slice(0, limit);
        const people = await readPeople(
          auth(c),
          page.map((membership) => membership.userId),
        );
        return c.json({
          members: page.map((membership) => adminMemberView(membership, people.get(membership.userId))),
          truncated: memberships.length > limit,
        } satisfies AdminMembersResponse);
      },
    );

    // ── membership administration: an operator's writes, each with a reason (#624) ────────────────

    app.patch(
      `${base}/admin/organizations/:organizationId`,
      describeRoute({
        summary: "Rename a tenant, give it a free short name, or set its seat limit.",
        description: "A short name another tenant holds is refused, naming that tenant. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_WRITE_SCOPE],
        responses: { 200: AdminOrganizationResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_WRITE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminUpdateOrganization),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        await operatorOrganization(c, organizationId);
        const updated = await updateOrganizationAsOperator(d1(c), {
          organizationId,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.seatLimit !== undefined ? { seatLimit: body.seatLimit } : {}),
          now: clock(),
        });
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminOrganizationUpdated,
          reason: body.reason,
          resource: { type: "organization", id: organizationId },
          // What it is now, field by field, and only the fields the request named.
          facts: {
            ...(body.name !== undefined ? { name: updated.name } : {}),
            ...(body.slug !== undefined ? { slug: updated.slug } : {}),
            ...(body.seatLimit !== undefined ? { seatLimit: updated.seatLimit ?? null } : {}),
          },
        });
        const counts = await memberCounts(db(c), [organizationId]);
        return c.json({
          organization: adminOrganizationView(updated, counts.get(organizationId) ?? 0, clock()),
        } satisfies AdminOrganizationResponse);
      },
    );

    // ── the organization's own lifecycle: suspend, reinstate, delete, restore (#623) ────────────────

    /**
     * Suspend a tenant. Nobody can act in it until it is reinstated or `until` passes, and a member's selection of
     * it is cleared on the request that finds it. A member of other organizations carries on in those.
     *
     * **`members: "sole"` reaches only the members whose only organization this is**, through the user lifecycle,
     * with this reason. The default reaches nobody. The owners are told, with the reason.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/suspend`,
      describeRoute({
        summary: "Suspend a tenant, with a reason: nobody can act in it until it is reinstated or its end passes.",
        description:
          '`members: "sole"` also suspends the accounts of the members whose only organization this is; a member of any other is never modified. The owners are told why. Takes a reason.',
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE],
        responses: { 200: AdminOrganizationSuspendResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminSuspendOrganization),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        const organization = await lifecycleOrganization(c, organizationId);
        const caller = operator(c);
        // Resolved before anything is written, so a Worker that cannot reach a member's account refuses the call
        // whole rather than suspending the organization and then failing its cascade.
        const cascade = body.members === "sole" ? cascadeDeps(c, organizationId) : undefined;
        const result = await suspendOrganization(lifecycle(c), {
          organizationId,
          actor: { type: "control-plane", id: caller.subject },
          reason: body.reason,
          until: body.until ? new Date(body.until) : null,
          restoreRoute: restoreRoute(organizationId),
        });
        const members = cascade
          ? await suspendSoleMembers(cascade, {
              organizationId,
              mode: "sole",
              reason: body.reason,
              until: result.suspendedUntil,
            })
          : NO_CASCADE;
        // An owner the cascade reached has their own account's suspension notice, with the same reason, and the
        // organization's notice ends by telling them their account is unaffected — so they are not sent it.
        const reached = new Set(members.reached.map((member) => member.userId));
        const recipients = await ownerRecipients(c, organizationId, reached);
        const mailed = await notifyOwners(config, mailer(c), recipients, {
          notice: "organizationSuspended",
          organizationName: organization.name,
          reason: body.reason,
          until: result.suspendedUntil,
        });
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminOrganizationSuspended,
          reason: body.reason,
          resource: { type: "organization", id: organizationId },
          severity: "warning",
          facts: {
            changed: result.changed,
            updated: result.updated,
            suspendedUntil: result.suspendedUntil?.toISOString() ?? null,
            ...cascadeFacts(members),
            mailed,
          },
        });
        return c.json(
          suspensionView(organizationId, result, mailed, members) satisfies AdminOrganizationSuspendResponse,
        );
      },
    );

    /**
     * Who suspending a tenant would reach, before it is suspended (#813). The write's body, validated the same
     * way and refused wherever the write would be refused, with the same error; the cascade's own selection,
     * with nothing applied. **It writes nothing** — no column, history row, mail, hook or audit act: a preview is
     * not an act, and the write that follows is the one on the trail. A snapshot, not a promise.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/suspend/preview`,
      describeRoute({
        summary: "Preview who suspending a tenant would reach, member by member, before it runs. Writes nothing.",
        description:
          "Takes the suspension's own body and refuses whatever it would refuse. `members` absent or `none` answers an empty cascade. A snapshot: a membership that changes before the suspension changes what it does.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE],
        responses: { 200: AdminMemberCascadePreviewResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminSuspendOrganization),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        // The write's refusals, in the write's order: the 404, the unwired cascade, then the suspension's own.
        await lifecycleOrganization(c, organizationId);
        const mode = body.members ?? "none";
        if (mode === "sole") userLifecycle();
        await checkSuspension(lifecycle(c), {
          organizationId,
          until: body.until ? new Date(body.until) : null,
          restoreRoute: restoreRoute(organizationId),
        });
        const members = await planSuspension({ db: db(c), auth: auth(c), now: clock() }, { organizationId, mode });
        return c.json({
          organizationId,
          members: memberCascadeView(members),
        } satisfies AdminMemberCascadePreviewResponse);
      },
    );

    /**
     * Lift a tenant's suspension. Its members see it again in their lists. **A member whose own account the
     * cascade suspended stays suspended**, and the response names every member whose account is still refused.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/reinstate`,
      describeRoute({
        summary: "Lift a tenant's suspension, with a reason. It is back in every member's list.",
        description:
          "Reinstates no member's own account, a cascade's included; `membersStillShut` names each one still refused. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE],
        responses: { 200: AdminOrganizationReinstateResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminReason),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        const organization = await lifecycleOrganization(c, organizationId);
        const caller = operator(c);
        const result = await reinstateOrganization(lifecycle(c), {
          organizationId,
          actor: { type: "control-plane", id: caller.subject },
          reason: body.reason,
          restoreRoute: restoreRoute(organizationId),
        });
        const mailed = result.changed
          ? await notifyOwners(config, mailer(c), await ownerRecipients(c, organizationId), {
              notice: "organizationReinstated",
              organizationName: organization.name,
            })
          : null;
        const shut = await membersStillShut(db(c), auth(c), organizationId, clock());
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminOrganizationReinstated,
          reason: body.reason,
          resource: { type: "organization", id: organizationId },
          facts: { changed: result.changed, membersStillShut: shut.length, mailed },
        });
        return c.json({
          organizationId,
          changed: result.changed,
          mailed,
          membersStillShut: shut,
        } satisfies AdminOrganizationReinstateResponse);
      },
    );

    /**
     * Delete a tenant. **Soft by default**: shut now, gone from every member's list, and restorable — memberships
     * and all — until `retention.purgeAfterDays` have passed; the owners are told the date. **`mode: "hard"`**
     * closes the window and starts the purge now. `members: "sole"` deletes, the same way, the accounts of the
     * members whose only organization this is.
     */
    app.delete(
      `${base}/admin/organizations/:organizationId`,
      describeRoute({
        summary:
          "Delete a tenant, with a reason: soft by default and restorable for its window; hard when named, purged now.",
        description:
          '`members: "sole"` also deletes the accounts of the members whose only organization this is; a member of any other is never modified. Takes a reason, in the body.',
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_DELETE_SCOPE],
        responses: { 200: AdminOrganizationDeleteResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_DELETE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminDeleteOrganization),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        const mode = body.mode ?? "soft";
        const organization = await lifecycleOrganization(c, organizationId);
        const caller = operator(c);
        // Read before anything moves, so a hard deletion's owners are known even once its purge has run.
        const owners = await ownerRecipients(c, organizationId);
        // Resolved before anything is written, for the reason the suspension resolves it first.
        const cascade = body.members === "sole" ? cascadeDeps(c, organizationId) : undefined;
        const result = await removeOrganization(lifecycle(c), {
          organizationId,
          actor: { type: "control-plane", id: caller.subject },
          reason: body.reason,
          mode,
          purgeAfterDays: config.retention.purgeAfterDays,
        });
        // Before the purge is started: the cascade asks who belongs elsewhere, and the purge takes the memberships.
        const members = cascade
          ? await deleteSoleMembers(cascade, {
              organizationId,
              mode: "sole",
              reason: body.reason,
              deletion: mode,
              onHard: (userId, deletedAt) => startMemberPurge(c, userId, deletedAt),
            })
          : NO_CASCADE;
        // A hard deletion starts its purge here; a soft one waits for the daily pass, unless its window has
        // already closed, in which case it is due now and is started like a hard one.
        const due = mode === "hard" || result.purgeAfter.getTime() <= clock().getTime();
        const purge = due ? await startOrganizationPurge(c, organizationId, result.deletedAt) : "scheduled";
        const mailed =
          mode === "soft" && result.outcome === "deleted"
            ? await notifyOwners(config, mailer(c), owners, {
                notice: "organizationDeletionScheduled",
                organizationName: organization.name,
                purgeOn: result.purgeAfter,
              })
            : null;
        await recordOperator(c, organizationId, {
          action:
            mode === "hard"
              ? OrganizationAuditActions.adminOrganizationHardDeleted
              : OrganizationAuditActions.adminOrganizationDeleted,
          reason: body.reason,
          resource: { type: "organization", id: organizationId },
          severity: "warning",
          facts: {
            mode,
            outcome: result.outcome,
            purgeAfter: result.purgeAfter.toISOString(),
            purge,
            ...cascadeFacts(members),
            mailed,
          },
        });
        return c.json(
          deletionView(organizationId, mode, result, purge, mailed, members) satisfies AdminOrganizationDeleteResponse,
        );
      },
    );

    /**
     * Who deleting a tenant would reach, softly or hard, before it is deleted (#813) — on the suspension preview's
     * terms: the write's body and refusals, the cascade's own selection, nothing applied and nothing written.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/delete/preview`,
      describeRoute({
        summary: "Preview who deleting a tenant would reach, member by member, before it runs. Writes nothing.",
        description:
          "Takes the deletion's own body and refuses whatever it would refuse. `members` absent or `none` answers an empty cascade. A snapshot: a membership that changes before the deletion changes what it does.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_DELETE_SCOPE],
        responses: { 200: AdminMemberCascadePreviewResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_DELETE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminDeleteOrganization),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        // The write's refusals, in the write's order: the 404, then the unwired cascade. A deletion refuses
        // nothing else before it moves.
        await lifecycleOrganization(c, organizationId);
        const mode = body.members ?? "none";
        if (mode === "sole") userLifecycle();
        const members = await planDeletion(
          { db: db(c), auth: auth(c), now: clock() },
          { organizationId, mode, deletion: body.mode ?? "soft" },
        );
        return c.json({
          organizationId,
          members: memberCascadeView(members),
        } satisfies AdminMemberCascadePreviewResponse);
      },
    );

    /**
     * Restore a deleted tenant inside its window, with every membership it had. After its window has closed it is
     * a conflict; after the purge, a 404 whose action says the data is gone. **No member's own account is
     * restored or reinstated**, and the response names each one still refused.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/restore`,
      describeRoute({
        summary: "Restore a deleted tenant inside its purge window, with every membership it had, and a reason.",
        description:
          "Restores no member's own account; `membersStillShut` names each one still suspended or deleted. A suspension the tenant was under stays. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_ACCOUNTS_DELETE_SCOPE],
        responses: { 200: AdminOrganizationRestoreResponse },
      }),
      gate(ORGANIZATION_ACCOUNTS_DELETE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminReason),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        await lifecycleOrganization(c, organizationId);
        const caller = operator(c);
        const result = await restoreOrganization(lifecycle(c), {
          organizationId,
          actor: { type: "control-plane", id: caller.subject },
          reason: body.reason,
        });
        const shut = await membersStillShut(db(c), auth(c), organizationId, clock());
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminOrganizationRestored,
          reason: body.reason,
          resource: { type: "organization", id: organizationId },
          facts: { changed: result.changed, state: result.state, membersStillShut: shut.length },
        });
        return c.json({
          organizationId,
          changed: result.changed,
          state: result.state,
          membersStillShut: shut,
        } satisfies AdminOrganizationRestoreResponse);
      },
    );

    /**
     * Add an existing user to a tenant, directly.
     *
     * **A membership, not an invitation**, because an operator adding somebody has already established that
     * they belong. The tenant is resolved first and the user second, so a typo'd account is a 404 about the
     * account and a typo'd user is a 404 about the user — never a 403, since the caller is already scoped.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/members`,
      describeRoute({
        summary: "Add an existing user to a tenant, at a named role.",
        description:
          "Refused for somebody already in it, naming their role, and past the seat limit unless the request overrides it. Never at the owning role: that refusal names the ownership route. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 201: AdminMemberResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("json", AdminAddMember),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const body = c.req.valid("json");
        const organization = await operatorOrganization(c, organizationId);
        const person = (await readPeople(auth(c), [body.userId])).get(body.userId);
        if (!person) {
          throw new NotFoundError({
            message: "No such user.",
            detail: `operator add of user ${body.userId}, who has no pithy_auth_users row`,
          });
        }
        const added = await addMember(d1(c), catalog, {
          organizationId,
          userId: body.userId,
          role: body.role,
          overrideSeatLimit: body.overrideSeatLimit ?? false,
          now: clock(),
          newId: ids,
          owner: ownerRule(organizationId),
        });
        const mailed = await sendMembershipNotice(config, mailer(c), {
          notice: "memberAdded",
          to: person,
          organizationName: organization.name,
          role: added.membership.role,
        });
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminMemberAdded,
          reason: body.reason,
          resource: { type: "membership", id: added.membership.id },
          facts: {
            role: added.membership.role,
            subjectUserId: body.userId,
            seatLimit: added.seatLimit,
            // Only true when the add went past the limit because the request said to.
            overrodeSeatLimit: added.overrodeSeatLimit,
            mailed,
          },
        });
        return c.json({ member: adminMemberView(added.membership, person) } satisfies AdminMemberResponse, 201);
      },
    );

    app.patch(
      `${base}/admin/organizations/:organizationId/members/:membershipId`,
      describeRoute({
        summary: "Change a member's role to any role the catalog declares but the owning one.",
        description:
          "Never to or from the owning role, which moves through the ownership route; that refusal names it, and so does the refusal to demote the last owner. Demoting the last administrator is refused. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 200: AdminMemberResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminMembershipParam),
      validate("json", AdminChangeRole),
      async (c) => {
        const { organizationId, membershipId } = c.req.valid("param");
        const body = c.req.valid("json");
        await operatorOrganization(c, organizationId);
        const database = db(c);
        const changed = await changeRoleAsOperator(d1(c), catalog, {
          organizationId,
          membershipId,
          role: body.role,
          owner: ownerRule(organizationId),
        });
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminMemberRoleChanged,
          reason: body.reason,
          resource: { type: "membership", id: changed.membership.id },
          facts: {
            role: changed.membership.role,
            previousRole: changed.previousRole,
            subjectUserId: changed.membership.userId,
          },
        });
        const membership = await readMembership(database, organizationId, changed.membership.id);
        const person = (await readPeople(auth(c), [membership.userId])).get(membership.userId);
        return c.json({ member: adminMemberView(membership, person) } satisfies AdminMemberResponse);
      },
    );

    app.delete(
      `${base}/admin/organizations/:organizationId/members/:membershipId`,
      describeRoute({
        summary: "Remove a member from a tenant, and clear their selection of it.",
        description:
          "Never an owner — the refusal names the ownership route, which can remove the previous owner — and never the last administrator. Takes a reason, in the body.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 200: AdminRemovedMemberResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminMembershipParam),
      validate("json", AdminReason),
      async (c) => {
        const { organizationId, membershipId } = c.req.valid("param");
        const body = c.req.valid("json");
        const organization = await operatorOrganization(c, organizationId);
        const removed = await removeMemberAsOperator(d1(c), catalog, {
          organizationId,
          membershipId,
          owner: ownerRule(organizationId),
        });
        const person = (await readPeople(auth(c), [removed.userId])).get(removed.userId);
        const mailed = person
          ? await sendMembershipNotice(config, mailer(c), {
              notice: "memberRemoved",
              to: person,
              organizationName: organization.name,
            })
          : null;
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminMemberRemoved,
          reason: body.reason,
          resource: { type: "membership", id: removed.id },
          facts: { role: removed.role, subjectUserId: removed.userId, mailed },
        });
        return c.json({ membershipId: removed.id, userId: removed.userId } satisfies AdminRemovedMemberResponse);
      },
    );

    app.get(
      `${base}/admin/organizations/:organizationId/invitations`,
      describeRoute({
        summary: "List a tenant's outstanding invitations, to fix one.",
        description:
          "Under the write scope, because the list is addresses and it is read to change one. The reason is recorded.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 200: AdminInvitationsResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminOrganizationParam),
      validate("query", AdminInvitationsQuery),
      async (c) => {
        const { organizationId } = c.req.valid("param");
        const query = c.req.valid("query");
        await operatorOrganization(c, organizationId);
        const limit = query.limit ?? MAX_PAGE_SIZE;
        const invitations = await listInvitations(db(c), organizationId, limit);
        const page = invitations.slice(0, limit);
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminInvitationsListed,
          reason: query.reason,
          resource: { type: "organization", id: organizationId },
          // A count, never the rows: the trail is not a second copy of who was invited.
          facts: { count: page.length, truncated: invitations.length > limit },
        });
        return c.json({
          invitations: page.map(invitationView),
          truncated: invitations.length > limit,
        } satisfies AdminInvitationsResponse);
      },
    );

    /**
     * Send an invitation again, with a fresh link — the fix for one that expired or went astray.
     *
     * **Expired or not**, because an expired offer is exactly the one an operator is asked to fix, and
     * `resendInvitation` restarts its life with a new token and kills the old one. The mail names the
     * person who first invited them, since that is whose offer it is; the operator's reason stays in the
     * trail.
     */
    app.post(
      `${base}/admin/organizations/:organizationId/invitations/:invitationId/resend`,
      describeRoute({
        summary: "Send a tenant's invitation again, with a fresh link.",
        description: "Expired or not. The old link stops working. Takes a reason.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 200: InviteResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminInvitationParam),
      validate("json", AdminReason),
      async (c) => {
        const { organizationId, invitationId } = c.req.valid("param");
        const body = c.req.valid("json");
        const organization = await operatorOrganization(c, organizationId);
        const database = db(c);

        const enqueue = config.sendInvitationEmail ? mailer(c) : undefined;
        if (config.sendInvitationEmail && !enqueue) {
          throw new InternalError({
            message: "That invitation could not be sent.",
            action: "Add `email(...)` to this Worker's capabilities, or set `sendInvitationEmail: false`.",
            detail: "sendInvitationEmail is true and no email capability published an enqueue seam",
          });
        }
        invitationAcceptUrl(config, "preflight");

        const existing = await requireInvitationInOrganization(database, organizationId, invitationId);
        // A role the catalog no longer assigns is dead rather than renewable: acceptance would refuse it,
        // so a fresh link would be a fresh refusal mailed to somebody.
        if (!catalog.AssignableRole.safeParse(existing.role).success) {
          throw offerInvalid(
            `invitation ${existing.id} offers role ${JSON.stringify(existing.role)}, which this catalog no longer assigns`,
          );
        }
        const minted = await resendInvitation(database, {
          organizationId,
          invitationId: existing.id,
          ttlDays: config.invitationTtlDays,
          now: clock(),
        });
        const acceptUrl = invitationAcceptUrl(config, minted.token);

        let sent: string | null = null;
        if (enqueue) {
          const inviter = (await readPeople(auth(c), [existing.invitedByUserId])).get(existing.invitedByUserId);
          const result = await sendInvitationMail(enqueue, {
            to: minted.invitation.email,
            organizationName: organization.name,
            inviterName: inviter?.name?.trim() || "Somebody",
            acceptUrl,
          });
          sent = result.status;
        }

        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminInvitationResent,
          reason: body.reason,
          resource: { type: "invitation", id: minted.invitation.id },
          facts: { role: minted.invitation.role, mailed: sent },
        });
        return c.json({
          invitation: invitationView(minted.invitation),
          acceptUrl: enqueue ? null : acceptUrl,
        } satisfies InviteResponse);
      },
    );

    app.delete(
      `${base}/admin/organizations/:organizationId/invitations/:invitationId`,
      describeRoute({
        summary: "Revoke a tenant's invitation, so its link stops working.",
        description: "Takes a reason, in the body.",
        verification: "control-plane",
        scopes: [ORGANIZATION_MEMBERS_WRITE_SCOPE],
        responses: { 200: WithdrawnInvitationResponse },
      }),
      gate(ORGANIZATION_MEMBERS_WRITE_SCOPE),
      validate("param", AdminInvitationParam),
      validate("json", AdminReason),
      async (c) => {
        const { organizationId, invitationId } = c.req.valid("param");
        const body = c.req.valid("json");
        await operatorOrganization(c, organizationId);
        const invitation = await withdrawInvitation(db(c), { organizationId, invitationId, now: clock() });
        await recordOperator(c, organizationId, {
          action: OrganizationAuditActions.adminInvitationRevoked,
          reason: body.reason,
          resource: { type: "invitation", id: invitation.id },
          facts: { role: invitation.role },
        });
        return c.json({ invitation: invitationView(invitation) } satisfies WithdrawnInvitationResponse);
      },
    );

    const transfer = options.ownership;
    if (transfer) {
      /**
       * Make a member the owner now. The break-glass path for an owner who has gone.
       *
       * **Mounted only where the project wires a transfer**, for the reason the member ownership routes are:
       * a catalog with nothing to own has no owner to force. Its own scope, so a credential that may fix a
       * roster cannot hand an account to somebody, and recorded at `warning`, because the account changed
       * hands and this is the act whose reason matters most.
       */
      app.post(
        `${base}/admin/organizations/:organizationId/ownership`,
        describeRoute({
          summary: "Make a member the owner now, with no nomination and no acceptance.",
          description:
            "The previous owner is kept, at the role a transfer falls back to, or removed, as the request says. Takes a reason.",
          verification: "control-plane",
          scopes: [ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE],
          responses: { 200: AdminOwnershipResponse },
        }),
        gate(ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE),
        validate("param", AdminOrganizationParam),
        validate("json", AdminForceOwnership),
        async (c) => {
          const { organizationId } = c.req.valid("param");
          const body = c.req.valid("json");
          const organization = await operatorOrganization(c, organizationId);
          const forced = await forceOwnership(d1(c), catalog, {
            organizationId,
            membershipId: body.membershipId,
            previousOwner: body.previousOwner,
            roles: transfer,
          });

          const people = await readPeople(auth(c), [
            forced.newHolder.userId,
            ...forced.previousHolders.map((holder) => holder.userId),
          ]);
          const owner = people.get(forced.newHolder.userId);
          const mailed = owner
            ? await sendMembershipNotice(config, mailer(c), {
                notice: "ownershipTransferred",
                to: owner,
                organizationName: organization.name,
              })
            : null;
          /*
            **Each previous holder gets an event of their own**, naming them, with this request's reason.
            A fact cannot be a list — `AuditFact` refuses containers — and with `remove` the membership is
            gone in the same batch, so without these nothing in the append-only trail would say whose
            ownership this act ended. A removed holder is a member removed by an operator, and is told so.
          */
          for (const holder of forced.previousHolders) {
            if (forced.removed) {
              const person = people.get(holder.userId);
              const removedMail = person
                ? await sendMembershipNotice(config, mailer(c), {
                    notice: "memberRemoved",
                    to: person,
                    organizationName: organization.name,
                  })
                : null;
              await recordOperator(c, organizationId, {
                action: OrganizationAuditActions.adminMemberRemoved,
                reason: body.reason,
                resource: { type: "membership", id: holder.id },
                facts: {
                  role: transfer.confers,
                  subjectUserId: holder.userId,
                  forcedOwnershipTo: forced.newHolder.id,
                  mailed: removedMail,
                },
              });
            } else {
              await recordOperator(c, organizationId, {
                action: OrganizationAuditActions.adminMemberRoleChanged,
                reason: body.reason,
                resource: { type: "membership", id: holder.id },
                facts: {
                  role: transfer.demotesTo,
                  previousRole: transfer.confers,
                  subjectUserId: holder.userId,
                  forcedOwnershipTo: forced.newHolder.id,
                },
              });
            }
          }

          await recordOperator(c, organizationId, {
            action: OrganizationAuditActions.adminOwnershipForced,
            reason: body.reason,
            resource: { type: "membership", id: forced.newHolder.id },
            severity: "warning",
            facts: {
              confers: transfer.confers,
              subjectUserId: forced.newHolder.userId,
              // The new holder's before and after (#831).
              role: transfer.confers,
              previousRole: forced.newHolder.previousRole,
              previousOwner: body.previousOwner,
              previousHolders: forced.previousHolders.length,
              mailed,
            },
          });
          return c.json({
            newHolderMembershipId: forced.newHolder.id,
            previousHolderMembershipIds: forced.previousHolders.map((holder) => holder.id),
            previousOwner: body.previousOwner,
          } satisfies AdminOwnershipResponse);
        },
      );
    }
  };

  /** How many people each named organization holds, in one grouped statement per chunk. */
  async function memberCounts(
    database: OrganizationDatabase,
    organizationIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let at = 0; at < organizationIds.length; at += ID_LOOKUP_CHUNK) {
      const chunk = organizationIds.slice(at, at + ID_LOOKUP_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await database
        .selectFrom(MEMBERSHIPS_TABLE)
        .select((eb) => ["organizationId" as const, eb.fn.countAll<number>().as("total")])
        .where("organizationId", "in", chunk)
        .groupBy("organizationId")
        .execute();
      for (const row of rows) counts.set(row.organizationId, Number(row.total));
    }
    return counts;
  }
}
