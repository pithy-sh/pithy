// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { consentAdminRoutes } from "./scopes";

/**
 * Every route `registerConsentRoutes` mounts under `base`: the management surface, then a person's own consent.
 */
export function consentRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(consentAdminRoutes(base)),
    ...declareRoutes(base, [
      ["GET", "/purposes"],
      ["GET", "/me"],
      ["GET", "/me/documents/:hash"],
      ["POST", "/grants"],
      ["POST", "/withdrawals"],
    ]),
  ];
}
