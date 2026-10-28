// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminRouteDeclaration } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * The leaderboard's control-plane scopes, and the admin surface a manifest advertises.
 *
 * **Separate from `guard.ts` because a scope name is a client's business**. A management client
 * reads these to render what a connection may do, and `pithy-sh/dashboard`'s scope builder writes the
 * `pithy dashboard connect --scope …` command from exactly these constants — in a browser program, with
 * the DOM lib and no Workers types. **This module imports types and nothing else, and a gate holds it
 * there**: `tooling/browser-scopes` compiles a DOM-only program against every scope the kit declares.
 *
 * ## Two scopes: reading a board, and changing one
 *
 * `scopeCovers` matches exactly, with no prefix or wildcard rule, so these confer nothing about each
 * other. A standings pane needs the read and nothing else; a moderation tool needs both. The read is a
 * read on every route that requires it, so `pithy dashboard connect` grants it by default. The write is
 * never in a default grant, because its routes are `POST`s.
 *
 * ## Not the player surface's admin scope
 *
 * `adminScope` (`leaderboard:admin` by default) gates the two player-surface moderation routes for the
 * adopter's own backend, read off `c.var.auth` by `requireAdminScope`. A management client has no `AuthContext` by design and can
 * never satisfy it, so these scopes replace that gate on the management routes rather than stacking with
 * it. Neither scope is configurable: a configurable scope name is a way to misconfigure a default-denied
 * gate into a differently-named one.
 */

/** Read a board: its definition, its entries with their moderation state, and the refresh lock. */
export const LEADERBOARD_ENTRIES_READ_SCOPE: ControlPlaneScope = "leaderboard:entries:read";

/** Change a board: hide, unhide or correct an entry, or clear a stale refresh lock. Each act is audited. */
export const LEADERBOARD_ENTRIES_MODERATE_SCOPE: ControlPlaneScope = "leaderboard:entries:moderate";

/** Every control-plane scope the leaderboard defines — what `pithy dashboard connect` offers for it. */
export const LEADERBOARD_CONTROL_PLANE_SCOPES: readonly ControlPlaneScope[] = [
  LEADERBOARD_ENTRIES_READ_SCOPE,
  LEADERBOARD_ENTRIES_MODERATE_SCOPE,
];

/**
 * The leaderboard's management surface, as `GET /control-plane/manifest` reports it.
 *
 * Built from the **resolved** `basePath`, never the default: an adopter who mounted the leaderboard at
 * `/ranks` gets a manifest naming `/ranks/admin/boards`, or a client composing its calls from it would 404.
 *
 * **Everything sits under an `admin/` segment, and its next segment is static.** The player surface owns
 * `${basePath}/:board` and `${basePath}/:board/<verb>`, so a board keyed `admin` still answers its player
 * routes: no management path is a player path with a board key in it.
 */
export function leaderboardAdminRoutes(basePath: string): AdminRouteDeclaration[] {
  return [
    {
      method: "GET",
      operation: "boards.list",
      path: `${basePath}/admin/boards`,
      scope: LEADERBOARD_ENTRIES_READ_SCOPE,
      kind: "reads",
      summary: "Every configured board: its store, direction, aggregation, window, and the window open now.",
    },
    {
      method: "GET",
      operation: "entries.list",
      path: `${basePath}/admin/boards/:board/entries`,
      scope: LEADERBOARD_ENTRIES_READ_SCOPE,
      kind: "reads",
      summary: "A window's entries, ranked and paged, hidden ones included, with the result that wrote each.",
    },
    {
      method: "GET",
      operation: "locks.list",
      path: `${basePath}/admin/locks`,
      scope: LEADERBOARD_ENTRIES_READ_SCOPE,
      kind: "reads",
      summary: "The rank-refresh lock, when one is held: its holder, and when it was taken.",
    },
    {
      method: "POST",
      operation: "entries.hide",
      path: `${basePath}/admin/boards/:board/entries/:userId/hide`,
      scope: LEADERBOARD_ENTRIES_MODERATE_SCOPE,
      kind: "writes",
      summary: "Hide an entry from every read, with a reason. The score is kept.",
    },
    {
      method: "POST",
      operation: "entries.unhide",
      path: `${basePath}/admin/boards/:board/entries/:userId/unhide`,
      scope: LEADERBOARD_ENTRIES_MODERATE_SCOPE,
      kind: "writes",
      summary: "Put a hidden entry back on the board, with a reason.",
    },
    {
      method: "POST",
      operation: "entries.correct",
      path: `${basePath}/admin/boards/:board/entries/:userId/correct`,
      scope: LEADERBOARD_ENTRIES_MODERATE_SCOPE,
      kind: "writes",
      summary: "Correct an entry's score, with a reason. The original is kept in its history.",
    },
    {
      method: "POST",
      operation: "locks.clear",
      path: `${basePath}/admin/locks/:name/clear`,
      scope: LEADERBOARD_ENTRIES_MODERATE_SCOPE,
      kind: "writes",
      summary: "Clear a stale rank-refresh lock, naming the holder it was taken by.",
    },
  ];
}
