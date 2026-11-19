// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ScopeGate } from "@pithy-sh/core/src/capability/capability";
import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import type { LeaderboardConfig } from "../config/config";
import { leaderboardAdminRoutes } from "./scopes";

/** The roots every board-addressed route mounts at: a configured board, and an instance of a family. */
const ROOTS = ["/:board", "/:board/:instance"] as const;

/**
 * Every route `registerLeaderboardRoutes` mounts under `base`, in the order it mounts them: the management
 * surface, the board list, each board-addressed route at both roots, and the submission at both roots last.
 */
export function leaderboardRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(leaderboardAdminRoutes(base)),
    ...declareRoutes(base, [
      ["GET", ""],
      ...ROOTS.flatMap(
        (root) =>
          [
            ["POST", `${root}/segment`],
            ["GET", `${root}/top`],
            ["GET", `${root}/me`],
            ["GET", `${root}/around`],
            ["PUT", `${root}/me/visibility`],
            ["PUT", `${root}/entries/:userId/hidden`],
            ["DELETE", `${root}/entries/:userId`],
          ] as const,
      ),
      ...ROOTS.map((root) => ["POST", root] as const),
    ]),
  ];
}

/**
 * The routes `registerLeaderboardRoutes` gates on an `AuthContext` scope, at both roots: moderating another
 * player's entry, and submitting a score while `serverAuthoritative` is on. `routeContract.test.ts` holds it to
 * the routes' own specs.
 */
export function leaderboardScopeGates(base: string, config: LeaderboardConfig): ScopeGate[] {
  return [
    ...ROOTS.flatMap((root) => [
      { scope: config.adminScope, route: `PUT ${base}${root}/entries/:userId/hidden` },
      { scope: config.adminScope, route: `DELETE ${base}${root}/entries/:userId` },
    ]),
    ...(config.serverAuthoritative
      ? ROOTS.map((root) => ({ scope: config.submitScope, route: `POST ${base}${root}` }))
      : []),
  ];
}
