// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { storageAdminRoutes } from "./scopes";

/** The power a role holds to edit, delete and re-scope any file in its own organization. */
export const STORAGE_MANAGE_POWER = "storage:manage";

/**
 * Every route `registerStorageRoutes` mounts: the management surface and the object routes under `base`, then the share link under `share`.
 */
export function storageRouteTable(base: string, share = "/s"): DeclaredRoute[] {
  return [
    ...adminRouteTable(storageAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", ""],
      ["GET", ""],
      ["DELETE", "/shares/:token"],
      ["POST", "/:id/complete"],
      ["POST", "/:id/abort"],
      ["GET", "/:id/parts"],
      ["POST", "/:id/copy"],
      ["POST", "/:id/shares"],
      ["GET", "/:id/url"],
      ["GET", "/:id"],
      ["HEAD", "/:id"],
      ["PATCH", "/:id"],
      ["DELETE", "/:id"],
    ]),
    { method: "GET", path: `${share}/:token` },
  ];
}
