// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { vectorAdminRoutes } from "./scopes";

/**
 * Every route `registerVectorRoutes` mounts under `base`: the management surface, then each index's documents.
 */
export function vectorRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(vectorAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/:index/documents"],
      ["POST", "/:index/query"],
      ["GET", "/:index/documents/:id"],
      ["DELETE", "/:index/documents/:id"],
    ]),
  ];
}
