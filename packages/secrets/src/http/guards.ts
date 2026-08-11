// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * The scope the secrets capability's management surface demands, and the surface it advertises.
 *
 * ## One scope, and it is its own
 *
 * `secrets:status:read` is granted separately from everything else an adopter grants at connect. That
 * separation is the point: the read is harmless in the sense that matters — it cannot disclose a value —
 * and it is sensitive in a different sense, because the list of which credentials a project holds, which
 * are stale, and which no automation will ever rotate is a map of where to push. An adopter who wants a
 * dashboard reading purchases and users without also handing over that map says so by not granting this,
 * and then it *cannot* be read, whatever the client intends.
 *
 * `scopeCovers` matches exactly, with no prefix or wildcard rule, so this confers nothing else and
 * nothing else confers it.
 *
 * ## Why the history is not a second scope
 *
 * `@pithy-sh/ledger` splits balances from the entry log behind them, because a number and a behavioural
 * record are different disclosures. Here they are the same disclosure at two resolutions: the listing
 * already reports the last successful rotation and the count, and the history adds the attempts between
 * them. Nothing appears in one that the other conceals, so a second grant would be a decision an adopter
 * could not act on.
 *
 * ## The gate is core's, and this capability verifies nothing itself
 *
 * `requireControlPlane` lives in `@pithy-sh/core/src/controlPlane/http/guard` and the routes wear it
 * directly. `@pithy-sh/core` is a hard dependency of every capability, so importing its gate cannot
 * leave a deployment without one — and with the seam uncomposed it raises `controlplane/not_connected`
 * rather than passing. There is no `requireAuth()` anywhere on this surface: the seam leaves
 * `c.var.auth` null by design, so an auth gate would deny every legitimate management call permanently.
 *
 * The name is a constant rather than config, because a configurable scope name is a way to misconfigure
 * a default-denied gate into a differently-named one — and it is the join key with what
 * `pithy dashboard connect` offers an adopter to grant.
 */

/** Read every declared secret's status, and one secret's rotation history. Metadata only, never a value. */
export const SECRETS_STATUS_READ_SCOPE: ControlPlaneScope = "secrets:status:read";

/**
 * Every control-plane scope this capability defines — what `pithy dashboard connect` offers for it, and
 * the list a manifest or a doc quotes rather than re-typing.
 */
export const SECRETS_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [SECRETS_STATUS_READ_SCOPE];

/**
 * The secrets capability's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Declared beside the scope rather than in `routes.ts` so the scope a route demands and the scope a
 * manifest advertises are the same constant, read from one place. `basePath` is a parameter and never a
 * default: an adopter who mounted this at `/vault` must get a manifest naming `/vault/admin/status`, or
 * a management client composing its calls from it would 404 against exactly the adopters who customised
 * anything.
 *
 * Everything sits under `admin/` for consistency with every other capability's management surface, and
 * so that a future non-management route under this mount point cannot collide with one of these.
 */
export function secretsAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/status`,
      scope: SECRETS_STATUS_READ_SCOPE,
      summary: "Every declared secret's status: when it was last rotated, how often, and whether it is overdue.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/status/:name/rotations`,
      scope: SECRETS_STATUS_READ_SCOPE,
      summary: "One secret's rotation history, newest first — when, how it ended, what caused it, and who.",
    },
  ];
}
