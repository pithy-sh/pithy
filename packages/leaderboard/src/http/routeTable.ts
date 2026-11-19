// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ScopeGate } from "@pithy-sh/core/src/capability/capability";
import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import type { LeaderboardConfig } from "../config/config";
import { leaderboardAdminRoutes } from "./scopes";

/**
 * Every route `registerLeaderboardRoutes` mounts under `base`: the management surface, then the boards.
 */
export function leaderboardRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(leaderboardAdminRoutes(base)),
    ...declareRoutes(base, [
      ["GET", ""],
      ["POST", "/:board/segment"],
      ["GET", "/:board/top"],
      ["GET", "/:board/me"],
      ["GET", "/:board/around"],
      ["PUT", "/:board/me/visibility"],
      ["PUT", "/:board/entries/:userId/hidden"],
      ["DELETE", "/:board/entries/:userId"],
      ["POST", "/:board"],
    ]),
  ];
}

/**
 * The routes `registerLeaderboardRoutes` gates on an `AuthContext` scope: moderating another player's entry, and
 * submitting a score while `serverAuthoritative` is on. `routeContract.test.ts` holds it to the routes' own specs.
 */
export function leaderboardScopeGates(base: string, config: LeaderboardConfig): ScopeGate[] {
  return [
    { scope: config.adminScope, route: `PUT ${base}/:board/entries/:userId/hidden` },
    { scope: config.adminScope, route: `DELETE ${base}/:board/entries/:userId` },
    ...(config.serverAuthoritative ? [{ scope: config.submitScope, route: `POST ${base}/:board` }] : []),
  ];
}
