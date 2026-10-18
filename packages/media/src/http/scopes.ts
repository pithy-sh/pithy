// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Media's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **This module imports types and nothing else**, because a management client in a browser reads the scope
 * names to render what a connection may do, and `tooling/browser-scopes` compiles every scope the kit
 * declares against the DOM lib alone.
 *
 * **Two scopes, both reads, because they are two disclosures.** What an account holds is numbers — records
 * and bytes per owner and per organization — and never a record, a filename or a URL. A per-owner figure is
 * always one organization's, so a tool holding it still cannot learn that a person holds an account in two
 * of them. What was served names every asset and how much attention each one got, so it is its own grant.
 */

/** Records and bytes held, per organization and per owner within one. */
export const MEDIA_USAGE_READ_SCOPE: ControlPlaneScope = "media:usage:read";

/**
 * **Read what this environment's media was served (#728).** Images delivered and minutes of video
 * watched, per asset, from Cloudflare's analytics. `scopeCovers` matches exactly, so this confers nothing
 * else and nothing else confers it. Every route requiring it is a `GET`, so `pithy dashboard connect`
 * grants it by default and an adopter can withhold it by naming the rest.
 */
export const MEDIA_DELIVERY_READ_SCOPE: ControlPlaneScope = "media:delivery:read";

/** Every control-plane scope this capability defines. */
export const MEDIA_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  MEDIA_USAGE_READ_SCOPE,
  MEDIA_DELIVERY_READ_SCOPE,
];

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
    {
      method: "GET",
      path: `${basePath}/admin/delivery`,
      scope: MEDIA_DELIVERY_READ_SCOPE,
      summary:
        "What this environment's media was served in a window — minutes of video and image requests, per asset, from Cloudflare's analytics.",
    },
  ];
}
