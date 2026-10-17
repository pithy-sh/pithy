// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Storage's control-plane scope, and the admin surface a manifest advertises.
 *
 * **This module imports types and nothing else**, because a management client in a browser reads the scope
 * names to render what a connection may do, and `tooling/browser-scopes` compiles every scope the kit
 * declares against the DOM lib alone.
 *
 * **One scope, a read, and it is numbers.** Files and bytes held, per owner and per organization — never a
 * path, a key or a link. A per-owner figure is always one organization's, so a tool holding this scope
 * still cannot learn that a person holds an account in two of them.
 */

/** Files and bytes held, per organization and per owner within one. */
export const STORAGE_USAGE_READ_SCOPE: ControlPlaneScope = "storage:usage:read";

/** Every control-plane scope this capability defines. */
export const STORAGE_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [STORAGE_USAGE_READ_SCOPE];

/**
 * The admin routes this capability advertises on `GET /control-plane/manifest`, built from the **resolved**
 * mount path, never the default.
 */
export function storageAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/usage`,
      scope: STORAGE_USAGE_READ_SCOPE,
      summary:
        "Files and bytes held, per organization or per owner within one organization. Never across organizations.",
    },
  ];
}
