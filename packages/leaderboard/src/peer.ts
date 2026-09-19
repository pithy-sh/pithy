// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { LeaderboardBoard } from "./config/config";
import { leaderboardDatabase } from "./data/tables";
import { entryStore } from "./entry/store";
import { ALL_TIME_WINDOW, windowKeyAt } from "./window/schedule";

/**
 * **What a capability composed beside the leaderboard may use — handed to it, never imported by it** (#645).
 *
 * `@pithy-sh/leaderboard` is an optional peer of `multiplayer`, which publishes a resolved session's result to
 * a board through the board's own submit path. It used to reach these modules by import, and a specifier naming
 * an optional package is one a bundler resolves whether or not the branch holding it ever runs — so a project
 * without the leaderboard could not bundle multiplayer at all.
 *
 * So `leaderboard()` carries this object as `leaderboardPeer`, and a dependent finds it among the composed
 * capabilities in its `compose` hook. The dependent names this package only in a type, which a bundler never
 * sees.
 */
export const leaderboardPeer = {
  LeaderboardBoard,
  leaderboardDatabase,
  entryStore,
  ALL_TIME_WINDOW,
  windowKeyAt,
} as const;

/** The leaderboard's peer surface, by type — what `leaderboardPeer` holds. */
export type LeaderboardPeer = typeof leaderboardPeer;
