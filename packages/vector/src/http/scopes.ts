// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Vector's control-plane scope, and the admin surface a manifest advertises (#730).
 *
 * **This module imports types and nothing else**, because a management client in a browser reads the scope
 * names to render what a connection may do, and `tooling/browser-scopes` compiles every scope the kit
 * declares against the DOM lib alone.
 */

/**
 * **Read every declared index's state.** What config declares, what Vectorize holds, how the corpus splits by
 * embedding model, how many namespaces it uses, and where each index stands against the provision record.
 * Never a document, a vector or a namespace name. `scopeCovers` matches exactly, so this confers nothing else
 * and nothing else confers it. Every route requiring it is a `GET`, so `pithy dashboard connect` grants it by
 * default and an adopter can withhold it by naming the rest.
 */
export const VECTOR_INDEXES_READ_SCOPE: ControlPlaneScope = "vector:indexes:read";

/** Every control-plane scope this capability defines. */
export const VECTOR_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [VECTOR_INDEXES_READ_SCOPE];

/** Where the vector routes mount when the adopter names no `basePath`. */
export const DEFAULT_VECTOR_BASE_PATH = "/vector";

/** The index read's path under the capability's mount point: `/vector/indexes` by default. */
export function vectorIndexesPath(basePath: string): string {
  return `${basePath}/indexes`;
}

/**
 * The admin routes this capability advertises on `GET /control-plane/manifest`, **fully mounted**: built from
 * the same `basePath` the routes register under, so an adopter who moved the mount point is reflected rather
 * than silently 404ing a client.
 */
export function vectorAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      operation: "indexes.list",
      path: vectorIndexesPath(basePath),
      scope: VECTOR_INDEXES_READ_SCOPE,
      summary:
        "Every declared index: what config declares, what Vectorize holds, how the corpus splits by embedding model, and whether it was provisioned.",
    },
  ];
}
