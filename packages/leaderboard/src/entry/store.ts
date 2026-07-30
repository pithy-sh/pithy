// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type SqlBool, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardEntry } from "../data/entry";
import { LEADERBOARD_ENTRIES_TABLE, type LeaderboardDatabase } from "../data/tables";

/**
 * Reads and writes over `pithy_leaderboard_entries`.
 *
 * Every write is one `INSERT … ON CONFLICT DO UPDATE` against the `(boardId, windowKey, userId)` unique
 * index. Folding the aggregation into the conflict clause — rather than reading the row, deciding in JS,
 * and writing it back — is what keeps a submission a single statement: D1 is single-threaded, so a
 * read-then-write would both double the round trips and open a race where two submissions from the same
 * player interleave and one silently wins.
 *
 * Round-trip rule (CLAUDE.md §Data layer): read with `LeaderboardEntry.parse` (decode), write with
 * `LeaderboardEntry.encode` (encode). No raw `0/1` or epoch numbers below.
 */
export interface EntryStore {
  /** Fold a submission into the player's entry for this window, per the board's aggregation. */
  submit(
    board: LeaderboardBoard,
    windowKey: string,
    userId: string,
    score: number,
    at: Date,
    visibleByDefault: boolean,
  ): Promise<void>;
  /** The player's entry for this window, or undefined if they have never submitted. */
  get(boardId: string, windowKey: string, userId: string): Promise<LeaderboardEntry | undefined>;
  /** Set the player's own consent to appear. False if they have no entry. */
  setVisibility(boardId: string, windowKey: string, userId: string, visible: boolean): Promise<boolean>;
  /** Hide or unhide an entry as a moderator. False if they have no entry. */
  hide(boardId: string, windowKey: string, userId: string, hidden: boolean): Promise<boolean>;
  /** Delete an entry outright. False if they have no entry. */
  remove(boardId: string, windowKey: string, userId: string): Promise<boolean>;
  /** Delete entries on this board in windows chronologically before `cutoffWindow`. Returns rows deleted. */
  pruneWindowsBefore(boardId: string, cutoffWindow: string): Promise<number>;
}

/**
 * The submission upsert, as a compilable query.
 *
 * Exported so `writeAmplification.workers.test.ts` can compile the real statement and read D1's own
 * `meta.rows_written` for it. The cost model in `scripts/costModel.ts` assumes a fixed number of rows
 * written per submission, and that assumption is load-bearing for every figure in docs/costs.md — a test
 * that measured a hand-written approximation of this SQL would only prove the approximation's cost.
 */
export function submitQuery(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  userId: string,
  score: number,
  at: Date,
  visibleByDefault: boolean,
) {
  const insert = LeaderboardEntry.encode({
    id: 0,
    boardId: board.key,
    windowKey,
    userId,
    score,
    achievedAt: at,
    submittedAt: at,
    visible: visibleByDefault,
    hidden: false,
    rank: null,
  }) as Record<string, unknown>;
  // `id` is autoincrement — let SQLite assign it rather than inserting the placeholder above.
  delete insert.id;

  const entries = sql.table(LEADERBOARD_ENTRIES_TABLE);
  const improves =
    board.direction === "desc"
      ? sql<SqlBool>`excluded.score > ${entries}.score`
      : sql<SqlBool>`excluded.score < ${entries}.score`;

  // On a `best` board with `trackActivity: false` (the default), a submission that does not beat the
  // stored score should cost nothing. A `WHERE` on the conflict clause makes SQLite skip the row
  // entirely — 0 rows written, versus 3 for a row it touches — which is the capability's biggest cost
  // lever, since most submissions do not improve a player's best. `sum`/`latest` always change the
  // score, so they always write and this guard never applies to them.
  const guardNoOps = board.aggregation === "best" && !board.trackActivity;

  const conflict = db
    .insertInto(LEADERBOARD_ENTRIES_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side; Kysely's insert type is derived from it.
    .values(insert as any)
    .onConflict((oc) => {
      const updated = oc.columns(["boardId", "windowKey", "userId"]).doUpdateSet(() => {
        // A submission advances submittedAt when it writes. With `trackActivity: false` a non-improving
        // `best` submission is skipped by the guard below and never reaches here, so submittedAt tracks
        // progress rather than activity. Neither the player's consent nor a moderator's hide is the
        // submitter's to reset, so `visible` and `hidden` are absent from every branch.
        const submittedAt = sql<number>`excluded.submitted_at`;
        if (board.aggregation === "latest") {
          return { submittedAt, score: sql<number>`excluded.score`, achievedAt: sql<number>`excluded.achieved_at` };
        }
        if (board.aggregation === "sum") {
          return {
            submittedAt,
            score: sql<number>`${entries}.score + excluded.score`,
            achievedAt: sql<number>`excluded.achieved_at`,
          };
        }
        // `best`: take the new score only if it improves in the board's direction. On an equal score
        // both branches keep the stored achievedAt, so a replay cannot cost a player the first-to-reach
        // tiebreak they already earned.
        return {
          submittedAt,
          score: sql<number>`CASE WHEN ${improves} THEN excluded.score ELSE ${entries}.score END`,
          achievedAt: sql<number>`CASE WHEN ${improves} THEN excluded.achieved_at ELSE ${entries}.achieved_at END`,
        };
      });
      return guardNoOps ? updated.where(improves) : updated;
    });

  return conflict;
}

export function entryStore(db: LeaderboardDatabase): EntryStore {
  return {
    async submit(board, windowKey, userId, score, at, visibleByDefault) {
      await submitQuery(db, board, windowKey, userId, score, at, visibleByDefault).execute();
    },

    async get(boardId, windowKey, userId) {
      const row = await db
        .selectFrom(LEADERBOARD_ENTRIES_TABLE)
        .selectAll()
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return row ? LeaderboardEntry.parse(row) : undefined;
    },

    async setVisibility(boardId, windowKey, userId, visible) {
      const result = await db
        .updateTable(LEADERBOARD_ENTRIES_TABLE)
        .set({ visible: LeaderboardEntry.shape.visible.encode(visible) })
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async hide(boardId, windowKey, userId, hidden) {
      const result = await db
        .updateTable(LEADERBOARD_ENTRIES_TABLE)
        .set({ hidden: LeaderboardEntry.shape.hidden.encode(hidden) })
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async remove(boardId, windowKey, userId) {
      const result = await db
        .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
        .where("boardId", "=", boardId)
        .where("windowKey", "=", windowKey)
        .where("userId", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async pruneWindowsBefore(boardId, cutoffWindow) {
      // Window keys are ISO instants, so `<` is chronological. `all` is never a windowed board's key, so
      // an all-time window (which retention never targets) cannot be caught here.
      const result = await db
        .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
        .where("boardId", "=", boardId)
        .where("windowKey", "<", cutoffWindow)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
