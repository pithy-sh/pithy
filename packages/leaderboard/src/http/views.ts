// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AdminEntry } from "../admin/read";
import { familyPrefix, type LeaderboardBoard, type LeaderboardConfig, type LeaderboardFamily } from "../config/config";
import type { LeaderboardBoardRecord } from "../data/boardRecord";
import type { LeaderboardLock } from "../data/lock";
import type { EntryModerationState } from "../data/moderation";
import { windowKeyAt } from "../window/schedule";
import type {
  AdminBoardView,
  AdminEntryState,
  AdminEntryView,
  AdminFamilyView,
  AdminInstanceView,
  AdminLockView,
} from "./responses";

/**
 * The management projections: stored rows into the response schemas, field by field.
 *
 * Deliberate rather than spread, so a column added to a table never reaches a management client by
 * accident. The entry's internal `id` and its stored `rank` stay behind: an entry is addressed by its
 * natural key, and the rank a moderator sees is counted live.
 */

export function adminBoardView(config: LeaderboardConfig, board: LeaderboardBoard, now: Date): AdminBoardView {
  return { key: board.key, ...adminShapeView(config, board, now) };
}

export function adminFamilyView(config: LeaderboardConfig, family: LeaderboardFamily, now: Date): AdminFamilyView {
  return { key: familyPrefix(family), pattern: family.pattern, ...adminShapeView(config, family, now) };
}

export function adminInstanceView(record: LeaderboardBoardRecord): AdminInstanceView {
  return { key: record.boardKey, createdAt: record.createdAt.toISOString() };
}

/** What a board and a family both show: the shape every board in them is read through. */
function adminShapeView(
  config: LeaderboardConfig,
  board: Omit<LeaderboardBoard, "key">,
  now: Date,
): Omit<AdminBoardView, "key"> {
  return {
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
