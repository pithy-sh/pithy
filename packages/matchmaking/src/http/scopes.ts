// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Matchmaking's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **This module imports types and nothing else** (#315). A management client names these in a browser program,
 * and `tooling/browser-scopes` compiles every scope the kit declares against the DOM lib alone.
 *
 * ## Two scopes: one to look, one to act
 *
 * `matchmaking:queues:read` is who is waiting: the queue, the open rooms and the pending invites. A read, so
 * `pithy dashboard connect` grants it by default. Its kind is `reads` (#725 classifies it when it lands).
 *
 * `matchmaking:queues:moderate` is the two acts: cancel an invite, drop a player from a queue. Every route
 * requiring it is a `POST`, so it never enters a default grant. Its kind is `writes`. `scopeCovers` matches
 * exactly, so holding the read confers neither act, and holding the acts discloses nothing on its own.
 *
 * **Neither reaches the friend graph.** Friend edges are the players' own: no admin route reads or writes one.
 */

/** Read who is waiting: a game's queue, its open rooms, and every pending invite. */
export const MATCHMAKING_QUEUES_READ_SCOPE: ControlPlaneScope = "matchmaking:queues:read";

/** Cancel a pending invite, or drop a player from a game's queue. Each with a key, a reason and an audit event. */
export const MATCHMAKING_QUEUES_MODERATE_SCOPE: ControlPlaneScope = "matchmaking:queues:moderate";

/** Every control-plane scope matchmaking defines — what `pithy dashboard connect` offers for it. */
export const MATCHMAKING_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  MATCHMAKING_QUEUES_READ_SCOPE,
  MATCHMAKING_QUEUES_MODERATE_SCOPE,
];

/**
 * Matchmaking's management surface, as `GET /control-plane/manifest` reports it, under the mounted `basePath`.
 *
 * Everything sits under an `admin/` segment, so no management path can collide with a player route: the player
 * surface owns `games/:game/...`, `invites/...` and `rooms/...` beneath the same base.
 */
export function matchmakingAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/games/:game/queue`,
      scope: MATCHMAKING_QUEUES_READ_SCOPE,
      summary: "Who is waiting in one game's queue: region, skill, band, and since when.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/games/:game/rooms`,
      scope: MATCHMAKING_QUEUES_READ_SCOPE,
      summary: "One game's open rooms: code, host, occupancy, and since when.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/invites`,
      scope: MATCHMAKING_QUEUES_READ_SCOPE,
      summary: "Every pending invite, newest first: game, inviter, invitee, and age.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/invites/:id/cancel`,
      scope: MATCHMAKING_QUEUES_MODERATE_SCOPE,
      summary: "Cancel a pending invite, with a reason. Both players are told.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/games/:game/queue/:userId/drop`,
      scope: MATCHMAKING_QUEUES_MODERATE_SCOPE,
      summary: "Drop a player from one game's queue, with a reason the player is told.",
    },
  ];
}
