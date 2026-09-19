// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { LeaderboardPeer } from "@pithy-sh/leaderboard/src/peer";
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
 * Publish a resolved session's result to a `@pithy-sh/leaderboard` board — one-way, through the surface the
 * composition handed over, so leaderboard stays an optional peer that nothing here imports (#645).
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
  peer: LeaderboardPeer | undefined,
): Promise<void> {
  if (peer === undefined) {
    throw new InternalError({
      message: "This game publishes to a leaderboard, and no leaderboard is composed.",
      action:
        "Add `leaderboard(...)` to this Worker's capabilities in pithy.config.ts, or drop the game's `leaderboard` block.",
      detail: `Board "${config.board}" was configured on the game and multiplayer() found no leaderboard among the composed capabilities.`,
    });
  }
  const { ALL_TIME_WINDOW, LeaderboardBoard, entryStore, leaderboardDatabase, windowKeyAt } = peer;
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
