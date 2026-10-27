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
 * one a listing credential comes with. Since the listing and detail routes are separate, a credential holding
 * only the detail scope cannot enumerate the trail to find ids to read, and a credential holding only the list scope
 * cannot resolve one. `scopeCovers` matches exactly — no prefix, no wildcard — so holding one confers nothing about
 * the other.
 *
 * **Usage rides the listing scope (#812).** `GET {base}/control-plane/usage` counts one connection's calls by scope
 * and key. Its answer is the scope, the key id, and the method and path of the last allowed call — the management
 * client's own footprint, which the listing already discloses in shape through `action`, `actorId` and `resourceId`
 * — and never an IP, a user-agent, or any other metadata key. So it needs no detail scope, and an access review does
 * not have to hold the most dangerous grant audit defines to ask which grants are used.
 *
 * **The access history rides the listing scope (#831).** `GET {base}/control-plane/access-history` answers every
 * membership, connection and key change in a window with its before and after — roles, scopes, the connection's
 * kind, purpose and principal, a key id. It lifts those named metadata keys and no other, and never an IP or a
 * user-agent, so replaying who could reach the data does not need the grant that discloses where everyone was.
 *
 * **Reach rides the listing scope (#828).** `GET {base}/control-plane/reach` answers what one credential touched:
 * per tenant, route and outcome, counts and two instants, and on request one route's called paths and the subject
 * ids they name. Those ids are segments of paths the credential itself sent, naming the subjects the listing
 * already names in `resourceId`, and the tenant is what it shows as `tenant`; the answer never carries an IP, a user-agent, or a metadata key beyond the key id, scope, method and
 * path. So a breach review does not need the detail scope to draw a breach scope.
 *
 * **The chain has a scope of its own (#822).** `GET {base}/control-plane/verify` walks one tenant's chain, and
 * `GET {base}/control-plane/export` takes it out in canonical form with its checkpoints. An export is the trail in
 * bulk, meant to leave the building, so neither read rides the listing scope: both need `audit:events:export`. The
 * export carries IP, user-agent and metadata values only when the connection also holds the detail scope, and their
 * salted hashes otherwise, which verify and disclose nothing.
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
 * Verify and export the hash chain (#822): walk one tenant's chain against its checkpoints, and take it out in
 * canonical form for an auditor to check offline. Kind `reads` under #725's table, declared in code once that lands.
 *
 * Its own scope, because an export is the trail in bulk — every event of a tenant, in a form meant to leave the
 * building. The IP, user-agent and metadata ride along only when the connection also holds
 * {@link AUDIT_EVENT_DETAIL_READ_SCOPE}; without it the export carries their salted hashes, which verify and
 * disclose nothing.
 */
export const AUDIT_CHAIN_EXPORT_SCOPE: ControlPlaneScope = "audit:events:export";

/**
 * Every control-plane scope audit defines — what `pithy dashboard connect` offers for this capability,
 * and the list a manifest or a doc quotes rather than re-typing.
 */
export const AUDIT_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  AUDIT_TRAIL_READ_SCOPE,
  AUDIT_EVENT_DETAIL_READ_SCOPE,
  AUDIT_CHAIN_EXPORT_SCOPE,
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
      path: `${basePath}/control-plane/access-history`,
      scope: AUDIT_TRAIL_READ_SCOPE,
      // Kind `reads` under #725's table, declared in code once that lands.
      summary:
        "Replay who could do what: every membership, connection and key change in a window, oldest first, with its before and after. No event is read in full.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/reach`,
      scope: AUDIT_TRAIL_READ_SCOPE,
      summary:
        "Read what one control-plane credential reached, by tenant, route and outcome, and expand a route into the subjects it touched.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/usage`,
      scope: AUDIT_TRAIL_READ_SCOPE,
      // Kind `reads` under #725's table, declared in code once that lands.
      summary:
        "Count which scopes one control-plane connection exercised and was refused, by key, over a window. Counts only — no event is read in full.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/verify`,
      scope: AUDIT_CHAIN_EXPORT_SCOPE,
      // Kind `reads` under #725's table, declared in code once that lands.
      summary:
        "Walk one tenant's hash chain against its checkpoints, and say whether it is whole or where it first breaks.",
    },
    {
      method: "GET",
      path: `${basePath}/control-plane/export`,
      scope: AUDIT_CHAIN_EXPORT_SCOPE,
      // Kind `reads` under #725's table, declared in code once that lands.
      summary:
        "Export one tenant's hash chain in canonical form with its checkpoints, to verify offline. Personal values only with the detail scope.",
    },
    {
      method: "GET",
      path: `${basePath}/events/:eventId`,
      scope: AUDIT_EVENT_DETAIL_READ_SCOPE,
      summary: "Read one event in full, including the client IP, user-agent, and capability metadata.",
    },
  ];
}
