// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { matchmakingAdminRoutes } from "./scopes";

/** Where the matchmaking routes mount when no `basePath` is given. */
export const MATCHMAKING_DEFAULT_BASE_PATH = "/matchmaking";

/**
 * Every route `registerMatchmakingRoutes` mounts under `base`: the management surface, rooms, invites, friends while `friends` is on, the queue and presence.
 */
export function matchmakingRouteTable(base: string, friends: boolean): DeclaredRoute[] {
  return [
    ...adminRouteTable(matchmakingAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/games/:game/rooms"],
      ["POST", "/rooms/:code/join"],
      ["POST", "/games/:game/invites"],
      ["GET", "/invites"],
      ["POST", "/invites/:id/accept"],
      ["POST", "/invites/:id/decline"],
      ...(friends
        ? ([
            ["GET", "/friends"],
            ["POST", "/friends/:userId/request"],
            ["POST", "/friends/:userId/accept"],
            ["POST", "/friends/:userId/decline"],
            ["DELETE", "/friends/:userId"],
          ] as const)
        : []),
      ["POST", "/games/:game/queue"],
      ["GET", "/games/:game/queue"],
      ["DELETE", "/games/:game/queue"],
      ["GET", "/presence"],
    ]),
  ];
}
