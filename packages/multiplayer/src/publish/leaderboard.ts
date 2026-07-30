// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { LeaderboardBoard } from "@pithy-sh/leaderboard/src/config/config";
import { leaderboardDatabase } from "@pithy-sh/leaderboard/src/data/tables";
import { entryStore } from "@pithy-sh/leaderboard/src/entry/store";
import { ALL_TIME_WINDOW, windowKeyAt } from "@pithy-sh/leaderboard/src/window/schedule";
import type { MultiplayerLeaderboard } from "../config/config";

/** What resolution hands the publisher — who played, who won, and when. */
export interface PublishInput {
  /** The session's members, in join order. */
  members: readonly string[];
  /** The winner's user id, or null on a draw. */
  winnerUserId: string | null;
  /** Whether the session was a draw. */
  draw: boolean;
  /** When the session resolved — the instant the window is computed from and the score is stamped with. */
  at: Date;
}

/**
 * Publish a resolved session's result to a `@pithy-sh/leaderboard` board — one-way, and only ever loaded
 * by dynamic import from the DO so leaderboard stays an optional peer.
 *
 * This is the composition seam the capability exists to demonstrate: a session's authority ends at its
 * result, and that result flows *into* the leaderboard's own submit path — the same `INSERT … ON CONFLICT`
 * upsert a score submission uses — rather than reimplementing ranking. Leaderboard never depends on
 * multiplayer; the arrow runs one direction only.
 *
 * The board's coordinates (direction, aggregation, window) are carried on the game's `leaderboard` config
 * and must match the leaderboard board's own definition — they decide how the awarded points fold in. A
 * points board is `sum`/`desc` by default: each session adds the winner's, loser's, or draw points to a
 * running total.
 */
export async function publishResultToLeaderboard(
  d1: D1Database,
  config: MultiplayerLeaderboard,
  input: PublishInput,
): Promise<void> {
  const board = LeaderboardBoard.parse({
    key: config.board,
    direction: config.direction,
    aggregation: config.aggregation,
    window: config.window,
  });
  const windowKey = config.window ? windowKeyAt(config.window, input.at) : ALL_TIME_WINDOW;
  const store = entryStore(leaderboardDatabase(d1));

  for (const userId of input.members) {
    const points = input.draw
      ? config.points.draw
      : userId === input.winnerUserId
        ? config.points.win
        : config.points.loss;
    await store.submit(board, windowKey, userId, points, input.at, true);
  }
}
