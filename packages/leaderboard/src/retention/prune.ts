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

/**
 * What a sweep over several boards deleted, and whether every board was swept (#371).
 *
 * The count sits behind the discriminant rather than beside a list of failures. A sweep that skipped a
 * board deleted fewer rows than a sweep that did not, and `{ deleted: 4 }` cannot tell those apart —
 * so `partial` spells the number differently, and a caller reaches it only by having been told the
 * sweep was short.
 */
export type PruneOutcome =
  | {
      /** Every board with a retention limit was swept. */
      state: "pruned";
      /** Rows deleted across them all. */
      deleted: number;
    }
  | {
      /** Some boards were swept and at least one threw. */
      state: "partial";
      /** What the boards that were swept deleted — a total with a known hole in it. */
      counted: { deleted: number };
      /** The key of every board whose prune threw. Non-empty, or this would be `pruned`. */
      unpruned: string[];
    };

/**
 * Prune every board that configures a retention limit.
 *
 * **One board at a time (#371).** Retention is per board and boards are independent, so a board whose
 * prune throws — a window key its config disagrees with, a D1 that stopped answering mid-sweep — used to
 * discard every deletion the sweep had already made and take the rank pass down with it. It now costs its
 * own entry and nothing else, and the boards it did not reach are named.
 *
 * **The guard takes no binding.** What a D1 write throws is throw-site context about somebody's database.
 * The board key is this capability's own configuration and is the only thing anybody can act on.
 */
export async function pruneBoards(
  db: LeaderboardDatabase,
  boards: readonly LeaderboardBoard[],
  now: Date,
): Promise<PruneOutcome> {
  let deleted = 0;
  const unpruned: string[] = [];
  for (const board of boards) {
    try {
      deleted += await pruneBoard(db, board, now);
    } catch {
      unpruned.push(board.key);
    }
  }
  return unpruned.length === 0 ? { state: "pruned", deleted } : { state: "partial", counted: { deleted }, unpruned };
}
