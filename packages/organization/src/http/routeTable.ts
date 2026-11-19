// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { DeclaredRoute } from "@pithy-sh/core/src/http/lazyRoutes";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { OwnerDeletionWiring } from "../lifecycle/ownerDelete";
import type { KitPower } from "../roles/roles";
import type { OrganizationRoutesOptions } from "./routes";
import {
  ORGANIZATION_ACCOUNTS_DELETE_SCOPE,
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
  ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
  ORGANIZATION_MEMBERS_READ_SCOPE,
  ORGANIZATION_MEMBERS_WRITE_SCOPE,
  ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE,
} from "./scopes";

/** Where a member's mark is served from, under the capability's base path. */
export const MEMBERS_PATH_SEGMENT = "/members";

/** The path segment an organization's mark is served under. */
export const MARKS_SEGMENT = "/marks";

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
  // Under the roster's scope: it is read to compose a roster write, and it names no account and no person.
  {
    method: "GET",
    path: "/admin/roles",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_READ_SCOPE,
    mutating: false,
  },
  // Membership administration. Every one takes a reason; each scope names a blast radius.
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
    method: "POST",
    path: "/admin/organizations/:organizationId/invitations/list",
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
  // The organization's own lifecycle. Each takes a reason; each scope is a power over whether the account
  // exists for its members at all.
  {
    method: "POST",
    path: "/admin/organizations/:organizationId/suspend",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_SUSPEND_SCOPE,
    mutating: true,
  },
  // Who the suspension's cascade would reach, before it runs. Behind the write's scope: who belongs to no
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
  // The deletion's preview, on the same terms as the suspension's.
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
 * Every route `registerOrganizationRoutes` mounts under `base`, read off {@link ORGANIZATION_ROUTES}: the
 * ownership routes only where the project has a transfer, behind the `ALL` its refusal recorder runs on.
 */
export function organizationRouteTable(base: string, ownership: boolean): DeclaredRoute[] {
  return [
    // The refusal recorder is `app.use` over the whole base, so every request under it enters the routes.
    { method: "ALL", path: `${base}/*` },
    ...ORGANIZATION_ROUTES.filter((route) => ownership || !route.ownership).map(({ method, path }) => ({
      method,
      path: `${base}${path}`,
    })),
  ];
}

/** The owner's deletion, configured from the same options the routes are, so the route and the export agree. */
export function ownerDeletionWiring<Power extends string, Role extends string>(
  options: OrganizationRoutesOptions<Power, Role>,
): OwnerDeletionWiring {
  return {
    catalog: options.catalog as unknown as OwnerDeletionWiring["catalog"],
    config: options.config,
    databaseBinding: options.databaseBinding ?? "DB",
    lifecycleHooks: options.lifecycleHooks ?? {},
    userLifecycle: () => options.userLifecycle?.(),
    enqueue: options.enqueue,
    now: options.now,
  };
}
