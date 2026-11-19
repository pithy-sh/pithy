// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { supportAdminRoutes } from "./scopes";

/**
 * Every route `registerSupportRoutes` mounts under `base`: the management surface, a staff member's own
 * assignment, and the customer-facing submission while `submission` is on.
 */
export function supportRouteTable(base: string, submission: boolean): DeclaredRoute[] {
  return [
    ...adminRouteTable(supportAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/staff/threads/:id/assign"],
      ...(submission
        ? ([
            ["POST", "/feedback"],
            ["GET", "/feedback"],
            ["GET", "/feedback/:id"],
          ] as const)
        : []),
    ]),
  ];
}
