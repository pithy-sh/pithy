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
 * ## Two scopes, and both are reads
 *
 * **Reads, because a write here has no actor.** Every mutation this capability ships is an
 * administrative act inside one account, taken by a member, and audited against the membership that
 * took it — `recordOrganizationAction` has no call shape that records one person's act inside another's
 * account. A control-plane credential holds no membership by design, so a management write would be a
 * change to somebody's roster attributed to nobody, in the one table an adopter reads to find out who
 * did what. The operator's path is the adopter's own code, calling the store functions directly with an
 * actor they can name.
 *
 * **Two rather than one, because these are two blast radii.** The account list is names, short names
 * and counts — what a support pane needs to find the right tenant. The roster is people's **addresses**,
 * which is personal data about the adopter's customers, and a tool that needed the first should never
 * silently hold the second. `scopeCovers` matches exactly, with no prefix rule and no wildcard, so
 * holding one confers nothing about the other.
 */

/** The account list: which tenants exist, what they are called, and how big they are. No addresses. */
export const ORGANIZATION_ACCOUNTS_READ_SCOPE: ControlPlaneScope = "organization:accounts:read";

/** One account's roster, with the people on it — names and addresses. The heavier of the two. */
export const ORGANIZATION_MEMBERS_READ_SCOPE: ControlPlaneScope = "organization:members:read";

/** Every control-plane scope this capability defines. */
export const ORGANIZATION_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_MEMBERS_READ_SCOPE,
];

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
export function organizationAdminRoutes(basePath: string): AdminRoute[] {
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
  ];
}
