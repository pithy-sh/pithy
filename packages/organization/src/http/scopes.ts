// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Tenancy's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from `guard.ts` because a scope name is a client's business.** A management client reads
 * these to render what a connection may do, and `pithy-sh/dashboard`'s scope builder writes the
 * `pithy dashboard connect --scope …` command from exactly these constants — in a browser program, with
 * the DOM lib and no Workers types. **This module imports types and nothing else**, and
 * `tooling/browser-scopes` compiles a DOM-only program against every scope the kit declares.
 *
 * ## Five scopes: two reads, and three writes that each name a blast radius
 *
 * **The reads are two rather than one, because these are two blast radii.** The account list is names,
 * short names and counts — what a support pane needs to find the right tenant. The roster is people's
 * **addresses**, which is personal data about the adopter's customers, and a tool that needed the first
 * should never silently hold the second. `scopeCovers` matches exactly, with no prefix rule and no
 * wildcard, so holding one confers nothing about the other.
 *
 * **The writes are membership administration (#624), and each one is an operator's act with an actor.**
 * A control-plane credential holds no membership, so an operator write is not recorded against one: it is
 * recorded with `actorType: "control-plane"`, the token's `sub` as the actor, the connection beside it,
 * and the reason the request was required to carry — `../audit/emit.ts`'s `recordOperatorAction`. That
 * is what made the original rule — *reads, because a write here has no actor* — stop being true.
 *
 * Three rather than one, because they are three different powers over somebody else's account:
 *
 * - `organization:members:write` — who is in it: add, remove, change a role, and fix an invitation. A
 *   roster write that puts somebody into the owning role or takes them out of it needs the transfer
 *   grant below as well, or this scope alone could add a second owner and remove the first.
 * - `organization:accounts:write` — what it is: its name, its short name, its seat limit.
 * - `organization:ownership:transfer` — who owns it, moved with no nomination and no acceptance. The one
 *   that most needs its own grant, because it is the break-glass path and nothing else can undo it.
 *
 * None implies another, and none implies a read. A client holding only the read scopes is refused every
 * write.
 */

/** The account list: which tenants exist, what they are called, and how big they are. No addresses. */
export const ORGANIZATION_ACCOUNTS_READ_SCOPE: ControlPlaneScope = "organization:accounts:read";

/** One account's roster, with the people on it — names and addresses. The heavier of the two. */
export const ORGANIZATION_MEMBERS_READ_SCOPE: ControlPlaneScope = "organization:members:read";

/** Who is in an account: add a member, remove one, change a role, and list, resend or revoke an invitation. */
export const ORGANIZATION_MEMBERS_WRITE_SCOPE: ControlPlaneScope = "organization:members:write";

/** What an account is: its name, its short name, and its seat limit. */
export const ORGANIZATION_ACCOUNTS_WRITE_SCOPE: ControlPlaneScope = "organization:accounts:write";

/** Who owns an account, moved immediately — no nomination and no acceptance. The break-glass write. */
export const ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE: ControlPlaneScope = "organization:ownership:transfer";

/** Every control-plane scope this capability defines. */
export const ORGANIZATION_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_MEMBERS_READ_SCOPE,
  ORGANIZATION_MEMBERS_WRITE_SCOPE,
  ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
  ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE,
];

/** What {@link organizationAdminRoutes} needs to know beyond the mount point. */
export interface OrganizationAdminRouteOptions {
  /**
   * Whether this project wires a transfer of ownership. Absent or false, the forced-ownership route is not
   * mounted, so it is not advertised either — a manifest naming a route that 404s is a promise to a client
   * that it cannot keep.
   */
  readonly ownership?: boolean;
}

/**
 * The admin routes this capability advertises on `GET /control-plane/manifest`.
 *
 * Built from the **resolved** `basePath`, never the default. An adopter who mounts this at `/accounts`
 * gets a manifest naming `/accounts/admin/organizations`, where a client assuming the default would
 * 404 — and the whole point of the manifest is that a management client composes its calls from the
 * Worker rather than from a route table it shipped with.
 *
 * Declared beside the scopes so the scope a route demands and the scope a manifest advertises are the
 * same constant.
 */
export function organizationAdminRoutes(basePath: string, options: OrganizationAdminRouteOptions = {}): AdminRoute[] {
  const one = `${basePath}/admin/organizations/:organizationId`;
  return [
    {
      method: "GET",
      path: `${basePath}/admin/organizations`,
      scope: ORGANIZATION_ACCOUNTS_READ_SCOPE,
      summary: "Every tenant, newest first, with how many people are in each. Bounded, and it says when it truncated.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/organizations/:organizationId/members`,
      scope: ORGANIZATION_MEMBERS_READ_SCOPE,
      summary: "One tenant's roster: who is in it, at what role, with the names and addresses behind the memberships.",
    },
    {
      method: "PATCH",
      path: one,
      scope: ORGANIZATION_ACCOUNTS_WRITE_SCOPE,
      summary: "Rename a tenant, give it a free short name, or set its seat limit. Takes a reason.",
    },
    {
      method: "POST",
      path: `${one}/members`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary: "Add an existing user at a named role, inside the seat limit or past it on purpose. Takes a reason.",
    },
    {
      method: "PATCH",
      path: `${one}/members/:membershipId`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary: "Change a member's role to any role the catalog declares. Never demotes the last owner. Takes a reason.",
    },
    {
      method: "DELETE",
      path: `${one}/members/:membershipId`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary: "Remove a member and clear their selection. Never the last owner. Takes a reason.",
    },
    {
      method: "GET",
      path: `${one}/invitations`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary: "A tenant's outstanding invitations, to fix one. Takes a reason.",
    },
    {
      method: "POST",
      path: `${one}/invitations/:invitationId/resend`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary:
        "Send an invitation again with a fresh link, expired or not. The old link stops working. Takes a reason.",
    },
    {
      method: "DELETE",
      path: `${one}/invitations/:invitationId`,
      scope: ORGANIZATION_MEMBERS_WRITE_SCOPE,
      summary: "Revoke an invitation, so its link stops working. Takes a reason.",
    },
    ...(options.ownership
      ? [
          {
            method: "POST" as const,
            path: `${one}/ownership`,
            scope: ORGANIZATION_OWNERSHIP_TRANSFER_SCOPE,
            summary:
              "Make a member the owner now, with no nomination and no acceptance. The previous owner stays or goes as the request says. Takes a reason.",
          },
        ]
      : []),
  ];
}
