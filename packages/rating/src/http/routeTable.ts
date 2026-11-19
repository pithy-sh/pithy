// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ScopeGate } from "@pithy-sh/core/src/capability/capability";
import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import type { RatingConfig } from "../config/config";
import { ratingAdminRoutes } from "./scopes";

/**
 * Every route `registerRatingRoutes` mounts under `base`: the management surface, then a game's outcomes and ratings.
 */
export function ratingRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(ratingAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/games/:game/outcomes"],
      ["GET", "/games/:game/me"],
      ["GET", "/games/:game/players/:userId"],
    ]),
  ];
}

/**
 * The routes `registerRatingRoutes` gates on an `AuthContext` scope: recording an outcome while
 * `serverAuthoritative` is on. `routeContract.test.ts` holds it to the routes' own specs.
 */
export function ratingScopeGates(base: string, config: RatingConfig): ScopeGate[] {
  return config.serverAuthoritative ? [{ scope: config.recordScope, route: `POST ${base}/games/:game/outcomes` }] : [];
}
