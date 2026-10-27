// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Multiplayer's control-plane scopes, and the admin surface a manifest advertises (#820).
 *
 * **This module imports types and nothing else** (#315). A management client names these in a browser program,
 * and `tooling/browser-scopes` compiles every scope the kit declares against the DOM lib alone.
 *
 * ## Two scopes: one to look, one to act
 *
 * `multiplayer:sessions:read` is what is in play and how it ended: the sessions in flight, one session read from
 * its Durable Object, and the results. A read, so `pithy dashboard connect` grants it by default. Its kind is
 * `reads` (#725 classifies it when it lands).
 *
 * `multiplayer:sessions:moderate` is the two acts: close a session in flight, void a result. Every route requiring
 * it is a `POST`, so it never enters a default grant. Its kind is `writes`. `scopeCovers` matches exactly, so
 * holding the read confers neither act, and holding the acts discloses nothing on its own.
 *
 * **Neither reads a game's hidden state.** A session read names its players, phase and deadline, never the model's
 * state, which holds what a player must not see.
 */

/** Read the sessions in flight, one session from its Durable Object, and the results. */
export const MULTIPLAYER_SESSIONS_READ_SCOPE: ControlPlaneScope = "multiplayer:sessions:read";

/** Close a session in flight, or void a result. Each with a key, a reason and an audit event. */
export const MULTIPLAYER_SESSIONS_MODERATE_SCOPE: ControlPlaneScope = "multiplayer:sessions:moderate";

/** Every control-plane scope multiplayer defines — what `pithy dashboard connect` offers for it. */
export const MULTIPLAYER_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  MULTIPLAYER_SESSIONS_READ_SCOPE,
  MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
];

/**
 * Multiplayer's management surface, as `GET /control-plane/manifest` reports it, under the mounted `basePath`.
 *
 * Everything sits under an `admin/` segment, so no management path can collide with a player route: the player
 * surface owns `games/:game` and `sessions/:id/...` beneath the same base.
 */
export function multiplayerAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/admin/sessions`,
      scope: MULTIPLAYER_SESSIONS_READ_SCOPE,
      summary: "Sessions in flight, newest first: game, phase, players and age.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/sessions/:id`,
      scope: MULTIPLAYER_SESSIONS_READ_SCOPE,
      summary: "One session, read from its Durable Object: players, phase, deadline and who is connected.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/sessions/:id/close`,
      scope: MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      summary: "Close a session in flight, with a reason its players are told. It records no result.",
    },
    {
      method: "GET",
      path: `${basePath}/admin/results`,
      scope: MULTIPLAYER_SESSIONS_READ_SCOPE,
      summary: "Results, most recently ended first: status, players, scores, winner or draw, and any void.",
    },
    {
      method: "POST",
      path: `${basePath}/admin/results/:id/void`,
      scope: MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      summary: "Void a result, with a reason. The leaderboard and rating take it back, each reported.",
    },
  ];
}
