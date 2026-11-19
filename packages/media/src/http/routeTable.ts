// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { mediaAdminRoutes } from "./scopes";

/** The power a role holds to edit, delete and re-scope any record in its own organization. */
export const MEDIA_MANAGE_POWER = "media:manage";

/**
 * Every route `registerMediaRoutes` mounts under `base`: the management surface, then the media routes.
 */
export function mediaRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(mediaAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/duplicates"],
      ["POST", ""],
      ["POST", "/:id/finalize"],
      ["GET", "/:id/url"],
      ["GET", "/:id"],
      ["PATCH", "/:id"],
      ["GET", ""],
      ["DELETE", "/:id"],
    ]),
  ];
}
