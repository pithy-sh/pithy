// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LeaderboardBoard } from "../config/config";
import type { LeaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { previousWindowKeys, windowKeyAt } from "../window/schedule";

/**
 * Retention: how long closed windows live.
 *
 * This is the capability's plainest expression of principle 1. Nothing in the market offers unbounded
 * leaderboard history — PlayFab meters retained versions and tier-gates them (its own tutorial defaults
 * to keeping one), and Game Center holds an expired occurrence about 30 days and says outright it is not
 * an archival store. Here, closed windows sit in the adopter's own D1 for exactly as long as they choose,
 * in plain SQL they can join against their own tables. And the default is to keep **everything**: storage
 * is never the cost driver (docs/costs.md — 3 GB at 10M players against a 10 GB cap), so nothing is
 * deleted unless the adopter asks. Retention here is about data hygiene and compliance, not cost.
 *
 * Two ways to ask, mutually exclusive per board (validated in config):
 *
 *   - `retain: N`     — keep the newest N closed windows. A product limit ("browse the last 12 weeks").
 *   - `retainDays: N` — delete windows whose data is older than N days. A compliance limit.
 *
 * An all-time board never closes a window, so retention does not apply to it.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function pruneBoard(db: LeaderboardDatabase, board: LeaderboardBoard, now: Date): Promise<number> {
  if (board.window === undefined) return 0;

  if (board.retain !== undefined) {
    // Keep the open window plus the newest `retain` closed ones. The kept set is a contiguous newest
    // suffix, so "delete everything not kept" is exactly "delete everything older than the oldest kept
    // window" — a cutoff delete with two bound parameters, rather than a `NOT IN` list that would blow
    // D1's 100-bound-parameter cap once `retain` reaches ~98 (a daily board keeping a year is retain 365).
    const closed = previousWindowKeys(board.window, now, board.retain);
    const oldestKept = closed.length > 0 ? (closed[closed.length - 1] as string) : windowKeyAt(board.window, now);
    return entryStore(db).pruneWindowsBefore(board.key, oldestKept);
  }

  if (board.retainDays !== undefined) {
    // Keep the window that was open `retainDays` ago and everything newer: that window is the oldest one
    // whose tail is still within the retention horizon. Its key is the cutoff — delete windows before it.
    // Window keys are ISO instants, so a lexicographic `<` is a chronological one.
    const cutoff = windowKeyAt(board.window, new Date(now.getTime() - board.retainDays * DAY_MS));
    return entryStore(db).pruneWindowsBefore(board.key, cutoff);
  }

  // Neither limit set: keep everything. The default.
  return 0;
}

/** Prune every board that configures a retention limit. Returns the total rows deleted. */
export async function pruneBoards(
  db: LeaderboardDatabase,
  boards: readonly LeaderboardBoard[],
  now: Date,
): Promise<number> {
  let deleted = 0;
  for (const board of boards) {
    deleted += await pruneBoard(db, board, now);
  }
  return deleted;
}
