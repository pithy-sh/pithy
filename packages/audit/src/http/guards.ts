// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Audit's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Every route here is `control-plane`, every route here is a read, and there are no others.** The
 * trail has no end-user surface — a user does not read the record of themselves being audited — so
 * there is nothing for `requireAuth()` to gate, and putting it on these routes would deny every
 * legitimate management call permanently: the seam deliberately leaves `c.var.auth` null for a
 * control-plane caller, and no credential could ever satisfy it. The gate is imported from core
 * rather than copied, because core is a hard dependency of every capability, so importing it cannot
 * leave a deployment without one; with the seam uncomposed `requireControlPlane` raises
 * `controlplane/not_connected` rather than passing.
 *
 * **Nothing here writes.** The trail is append-only by construction and stays that way: there is no
 * delete route, no edit route, and no retention control on this surface. A management credential that
 * could erase an audit row is a management credential that can erase the evidence of its own use.
 *
 * ## Two read scopes, because two reads disclose different things
 *
 * The tempting shape is one `audit:read`. It is wrong on the merits for the same reason a single
 * `payments:admin` flag was: it makes the safe operation and the dangerous one the same grant.
 *
 * A **page of the trail** answers who did what, when, and whether it worked. That is the "recent
 * activity" pane, it is what an operator looks at all day, and its projection carries no network
 * identifier and no capability payload.
 *
 * **One event in full** additionally carries the client IP, the user-agent, and the capability's own
 * `metadata` bag — which routinely holds the email address, the resource name, or the reason a
 * capability recorded alongside its event. Bulk-harvesting those over a whole trail is a privacy
 * incident, and requiring a second scope is what makes it a decision the adopter makes rather than
 * one a listing credential comes with. Since the two are separate routes, a credential holding only
 * the detail scope cannot enumerate the trail to find ids to read, and a credential holding only the
 * list scope cannot resolve one. `scopeCovers` matches exactly — no prefix, no wildcard — so holding
 * one confers nothing about the other.
 *
 * The names are constants rather than config: a configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one, and they are the join key with what
 * `pithy dashboard connect` offers an adopter to grant.
 */

/**
 * Page the trail: who acted, what they did, when, against what, and whether it was allowed. The
 * everyday read, and deliberately the one that carries no IP address and no capability metadata.
 */
export const AUDIT_TRAIL_READ_SCOPE: ControlPlaneScope = "audit:events:read";

/**
 * Read one event in full — the client IP, the user-agent, and the capability's `metadata` bag with it.
 * The forensic read, and the more dangerous of the two: this is where the trail's personal data is.
 */
export const AUDIT_EVENT_DETAIL_READ_SCOPE: ControlPlaneScope = "audit:events:read_detail";

/**
 * Every control-plane scope audit defines — what `pithy dashboard connect` offers for this capability,
 * and the list a manifest or a doc quotes rather than re-typing.
 */
export const AUDIT_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  AUDIT_TRAIL_READ_SCOPE,
  AUDIT_EVENT_DETAIL_READ_SCOPE,
];

/**
 * Audit's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scopes so the scope a route demands and the scope a manifest advertises are the
 * same constant, read from one place. `basePath` is a parameter and never a default: an adopter who
 * mounted audit at `/trail` must get a manifest naming `/trail/events`, or a client composing its
 * calls from the manifest would 404 against exactly the adopters who customized anything.
 *
 * The summaries say what the operation is *for*. A client renders these beside a pane somebody is
 * about to open over other people's activity.
 */
export function auditAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/events`,
      scope: AUDIT_TRAIL_READ_SCOPE,
      summary:
        "Page the trail, newest first, filtered by actor, action, resource, outcome, severity, origin, and time.",
    },
    {
      method: "GET",
      path: `${basePath}/events/:eventId`,
      scope: AUDIT_EVENT_DETAIL_READ_SCOPE,
      summary: "Read one event in full, including the client IP, user-agent, and capability metadata.",
    },
  ];
}
