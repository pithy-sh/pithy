// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminEntry } from "../admin/read";
import type { LeaderboardBoard, LeaderboardConfig } from "../config/config";
import type { LeaderboardLock } from "../data/lock";
import type { EntryModerationState } from "../data/moderation";
import { windowKeyAt } from "../window/schedule";
import type { AdminBoardView, AdminEntryState, AdminEntryView, AdminLockView } from "./responses";

/**
 * The management projections (#817): stored rows into the response schemas, field by field.
 *
 * Deliberate rather than spread, so a column added to a table never reaches a management client by
 * accident. The entry's internal `id` and its stored `rank` stay behind: an entry is addressed by its
 * natural key, and the rank a moderator sees is counted live.
 */

export function adminBoardView(config: LeaderboardConfig, board: LeaderboardBoard, now: Date): AdminBoardView {
  return {
    key: board.key,
    store: board.store,
    direction: board.direction,
    aggregation: board.aggregation,
    window: board.window ?? null,
    currentWindow: windowKeyAt(board.window, now),
    min: board.min ?? null,
    max: board.max ?? null,
    rank: typeof config.rank === "object" ? "materialized" : "live",
  };
}

export function adminEntryView({ entry, rank }: AdminEntry): AdminEntryView {
  return {
    userId: entry.userId,
    score: entry.score,
    rank,
    achievedAt: entry.achievedAt.toISOString(),
    submittedAt: entry.submittedAt.toISOString(),
    visible: entry.visible,
    hidden: entry.hidden,
    resultId: entry.resultId ?? null,
  };
}

export function adminLockView(
  lock: Pick<LeaderboardLock, "name" | "holder"> & { acquiredAt: Date | string },
): AdminLockView {
  return {
    name: lock.name,
    holder: lock.holder,
    acquiredAt: typeof lock.acquiredAt === "string" ? lock.acquiredAt : lock.acquiredAt.toISOString(),
  };
}

export function adminEntryState(state: EntryModerationState): AdminEntryState {
  return { score: state.score, visible: state.visible, hidden: state.hidden };
}
