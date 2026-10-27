// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * Rating's control-plane scopes, and the admin surface a manifest advertises (#818).
 *
 * **Separate from `guard.ts` because a scope name is a client's business** (#315). A management client
 * reads these to render what a connection may do, and the dashboard's scope builder writes
 * `pithy dashboard connect --scope …` from exactly these constants, in a browser program with no Workers
 * types. This module imports types and nothing else, and `tooling/browser-scopes` holds it there.
 *
 * ## Two scopes: reading a rating, and changing one
 *
 * `scopeCovers` matches exactly, so neither confers the other. A support pane that shows why a player
 * sits where they do needs the read and nothing more; a recalculation rewrites somebody's standing, and an
 * adopter must be able to grant the first without the second.
 *
 * - `rating:players:read` declares kind `reads` and `rating:players:adjust` kind `writes`, per #725's rule
 *   that a scope added later declares its kind in its own issue. #725 classifies them when it lands.
 *
 * The names are constants rather than config: a configurable scope name is a way to misconfigure a
 * default-denied gate into a differently-named one.
 */

/** Read pools, ratings in a pool, and one player's rating with the outcomes behind it. */
export const RATING_PLAYERS_READ_SCOPE: ControlPlaneScope = "rating:players:read";

/**
 * Recalculate a player's rating from the outcome log, or reset it to the algorithm's starting state. Each
 * act takes an idempotency key and a reason, and is audited.
 */
export const RATING_PLAYERS_ADJUST_SCOPE: ControlPlaneScope = "rating:players:adjust";

/** Every control-plane scope rating defines — what `pithy dashboard connect` offers for this capability. */
export const RATING_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  RATING_PLAYERS_READ_SCOPE,
  RATING_PLAYERS_ADJUST_SCOPE,
];

/**
 * Rating's management surface, as `GET /control-plane/manifest` reports it. `basePath` is a parameter,
 * never a default, so an adopter who mounted rating elsewhere gets a manifest naming where it is.
 *
 * **Everything sits under `admin/`**, which the player surface never uses: its routes all begin
 * `games/`, so the two sets cannot collide whatever a pool is called.
 */
export function ratingAdminRoutes(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      operation: "pools.list",
      path: `${basePath}/admin/pools`,
      scope: RATING_PLAYERS_READ_SCOPE,
      summary: "Every rating pool, its algorithm, and the games that rate it.",
    },
    {
      method: "GET",
      operation: "players.list",
      path: `${basePath}/admin/pools/:pool/players`,
      scope: RATING_PLAYERS_READ_SCOPE,
      summary: "The ratings in one pool, highest skill first.",
    },
    {
      method: "GET",
      operation: "players.read",
      path: `${basePath}/admin/pools/:pool/players/:userId`,
      scope: RATING_PLAYERS_READ_SCOPE,
      summary: "One player's rating in a pool, and the outcomes behind it, newest first.",
    },
    {
      method: "POST",
      operation: "players.recalculate",
      path: `${basePath}/admin/pools/:pool/players/:userId/recalculate`,
      scope: RATING_PLAYERS_ADJUST_SCOPE,
      summary: "Rebuild one player's rating by replaying their logged outcomes.",
    },
    {
      method: "POST",
      operation: "players.reset",
      path: `${basePath}/admin/pools/:pool/players/:userId/reset`,
      scope: RATING_PLAYERS_ADJUST_SCOPE,
      summary: "Return one player's rating to the algorithm's starting state.",
    },
  ];
}
