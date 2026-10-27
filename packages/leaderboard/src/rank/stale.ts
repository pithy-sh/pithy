// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CompiledQuery, type Expression, type SqlBool, sql } from "kysely";
import { LeaderboardStaleWindow } from "../data/staleWindow";
import { LEADERBOARD_STALE_WINDOWS_TABLE, type LeaderboardDatabase } from "../data/tables";

/**
 * The windows an act or a void left with out-of-date stored ranks (#817), and the refresh pass's way of
 * finding and finishing them.
 *
 * The pass renumbers the open window every time. A closed window stops moving when it closes, unless a
 * moderator moves it, and that is when cheating is usually found. So whatever moves one marks it here, in
 * the same `d1.batch()` as its change, and the pass renumbers every marked window once and clears the mark.
 * A request never renumbers a window itself: that would race the refresh lock, and a large board's
 * renumber does not fit a request.
 */

/** A window waiting for a renumber, as the pass read it. `markedAt` is epoch ms, so a Workflow step can return it. */
export interface StaleWindow {
  windowKey: string;
  markedAt: number;
}

/**
 * The statement that marks one window stale, for the caller's batch. A window marked again moves its
 * `markedAt` forward, which is what keeps a mark made while a pass ran from being cleared by that pass.
 *
 * `when` makes the mark conditional on the batch's own outcome, so a change that did not happen marks
 * nothing. Without it the mark is unconditional.
 */
export function markStale(
  db: LeaderboardDatabase,
  boardId: string,
  windowKey: string,
  at: Date,
  when: Expression<SqlBool> = sql<SqlBool>`1`,
): CompiledQuery {
  const row = LeaderboardStaleWindow.encode({ boardId, windowKey, markedAt: at });
  return (
    db
      .insertInto(LEADERBOARD_STALE_WINDOWS_TABLE)
      .columns(["boardId", "windowKey", "markedAt"])
      // An `INSERT … SELECT` with an upsert needs the `WHERE`, or SQLite cannot tell `ON CONFLICT` from a join.
      .expression(
        db
          .selectNoFrom([
            sql.val(row.boardId).as("boardId"),
            sql.val(row.windowKey).as("windowKey"),
            sql.val(row.markedAt).as("markedAt"),
          ])
          .where(when),
      )
      .onConflict((oc) => oc.columns(["boardId", "windowKey"]).doUpdateSet({ markedAt: row.markedAt }))
      .compile()
  );
}

/** Every window of one board waiting for a renumber, oldest key first. */
export async function staleWindows(db: LeaderboardDatabase, boardId: string): Promise<StaleWindow[]> {
  const rows = await db
    .selectFrom(LEADERBOARD_STALE_WINDOWS_TABLE)
    .selectAll()
    .where("boardId", "=", boardId)
    .orderBy("windowKey")
    .execute();
  return rows.map((row) => {
    const parsed = LeaderboardStaleWindow.parse(row);
    return { windowKey: parsed.windowKey, markedAt: parsed.markedAt.getTime() };
  });
}

/**
 * Clear a window's mark once it is renumbered — only the mark the pass read. One marked again since is
 * newer, and stays for the next pass, because the renumber may have read the window before that change.
 */
export async function clearStale(db: LeaderboardDatabase, boardId: string, window: StaleWindow): Promise<void> {
  await db
    .deleteFrom(LEADERBOARD_STALE_WINDOWS_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "=", window.windowKey)
    .where("markedAt", "<=", window.markedAt)
    .execute();
}
