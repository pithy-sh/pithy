// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { multiplayerAdminRoutes } from "./scopes";

/** Where the multiplayer routes mount when no `basePath` is given. */
export const MULTIPLAYER_DEFAULT_BASE_PATH = "/multiplayer";

/**
 * Every route `registerMultiplayerRoutes` mounts under `base`: the management surface, then sessions and their socket.
 */
export function multiplayerRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(multiplayerAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/games/:game"],
      ["POST", "/sessions/:id/join"],
      ["POST", "/sessions/:id/action"],
      ["POST", "/sessions/:id/leave"],
      ["POST", "/sessions/:id/close"],
      ["GET", "/sessions/:id/result"],
      ["GET", "/sessions/:id/socket"],
      ["GET", "/sessions/:id"],
    ]),
  ];
}
