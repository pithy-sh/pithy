// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRouteDeclaration } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Turnstile's control-plane scope, and the admin surface a manifest advertises.
 *
 * **This module imports types and nothing else**, because a management client in a browser reads the scope
 * names to render what a connection may do, and `tooling/browser-scopes` compiles every scope the kit
 * declares against the DOM lib alone.
 */

/**
 * **Read which widget guards this environment, and how its challenges went.** The sitekey in force, whether
 * it is a test key, and challenge outcomes from Cloudflare's analytics. `scopeCovers` matches exactly, so
 * this confers nothing else and nothing else confers it. Every route requiring it is a `GET`, so
 * `pithy dashboard connect` grants it by default and an adopter can withhold it by naming the rest.
 */
export const TURNSTILE_WIDGETS_READ_SCOPE: ControlPlaneScope = "turnstile:widgets:read";

/** Every control-plane scope this capability defines. */
export const TURNSTILE_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [TURNSTILE_WIDGETS_READ_SCOPE];

/** The path the widget read mounts at. Turnstile mounts nothing else. */
export const TURNSTILE_WIDGETS_PATH = "/turnstile/admin/widgets";

/** The admin routes this capability advertises on `GET /control-plane/manifest`. */
export function turnstileAdminRoutes(): AdminRouteDeclaration[] {
  return [
    {
      method: "GET",
      operation: "widgets.list",
      path: TURNSTILE_WIDGETS_PATH,
      scope: TURNSTILE_WIDGETS_READ_SCOPE,
      kind: "reads",
      summary:
        "Which widget guards this environment, whether it is a real one or a test key, and how its challenges went in a window, from Cloudflare's analytics.",
    },
  ];
}
