// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Media's control-plane scope, and the admin surface a manifest advertises.
 *
 * **This module imports types and nothing else**, because a management client in a browser reads the scope
 * names to render what a connection may do, and `tooling/browser-scopes` compiles every scope the kit
 * declares against the DOM lib alone.
 *
 * **One scope, a read, and it is numbers.** What an account holds — records and bytes per owner and per
 * organization — and never a record, a filename or a URL. A per-owner figure is always one organization's,
 * so a tool holding this scope still cannot learn that a person holds an account in two of them.
 */

/** Records and bytes held, per organization and per owner within one. */
export const MEDIA_USAGE_READ_SCOPE: ControlPlaneScope = "media:usage:read";

/** Every control-plane scope this capability defines. */
export const MEDIA_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [MEDIA_USAGE_READ_SCOPE];

/**
 * The admin routes this capability advertises on `GET /control-plane/manifest`, built from the **resolved**
 * mount path, never the default — an adopter who mounts media at `/files` gets a manifest naming
 * `/files/admin/usage`.
 */
export function mediaAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/usage`,
      scope: MEDIA_USAGE_READ_SCOPE,
      summary:
        "Records and bytes held, per organization or per owner within one organization. Never across organizations.",
    },
  ];
}
