// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { type CompiledQuery, type SqlBool, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardEntry } from "../data/entry";
import {
  LEADERBOARD_CONTRIBUTIONS_TABLE,
  LEADERBOARD_ENTRIES_TABLE,
  LEADERBOARD_MODERATIONS_TABLE,
  LEADERBOARD_STALE_WINDOWS_TABLE,
  type LeaderboardDatabase,
  leaderboardDatabase,
} from "../data/tables";

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
  resultId?: string,
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
    ...(resultId === undefined ? {} : { resultId }),
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

  // A result-sourced submission folds in once per result (#817). The contribution row its batch writes
  // second is what a retry finds, so both halves of the upsert stand down when it is already there — the
  // insert by selecting nothing, the update by its `WHERE`. A plain submission compiles exactly as before.
  const unrecorded =
    resultId === undefined
      ? undefined
      : sql<SqlBool>`not exists ${db
          .selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
          .select(sql.lit(1).as("one"))
          .where("resultId", "=", resultId)
          .where("boardId", "=", board.key)
          .where("windowKey", "=", windowKey)
          .where("userId", "=", userId)}`;

  const columns = Object.keys(insert);
  const rows =
    unrecorded === undefined
      ? db
          .insertInto(LEADERBOARD_ENTRIES_TABLE)
          // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side; Kysely's insert type is derived from it.
          .values(insert as any)
      : db
          .insertInto(LEADERBOARD_ENTRIES_TABLE)
          // biome-ignore lint/suspicious/noExplicitAny: the encoded row's own keys, which are the table's columns.
          .columns(columns as any)
          .expression(
            db
              .selectNoFrom(columns.map((column) => sql.val(insert[column]).as(column)))
              // The `WHERE` is also what SQLite needs to read `ON CONFLICT` as the upsert's, not the select's.
              .where(unrecorded),
          );

  const conflict = rows.onConflict((oc) => {
    const updated = oc.columns(["boardId", "windowKey", "userId"]).doUpdateSet(() => {
      // A submission advances submittedAt when it writes. With `trackActivity: false` a non-improving
      // `best` submission is skipped by the guard below and never reaches here, so submittedAt tracks
      // progress rather than activity. Neither the player's consent nor a moderator's hide is the
      // submitter's to reset, so `visible` and `hidden` are absent from every branch.
      const submittedAt = sql<number>`excluded.submitted_at`;
      // The result id follows the score it names (#817). Whatever now holds a `latest` board's score wrote
      // it, so a plain submission clears it; a `best` board moves it only with an improving score; a `sum`
      // board keeps the last result folded in, because a plain submission added to the total rather than
      // replacing it.
      if (board.aggregation === "latest") {
        return {
          submittedAt,
          score: sql<number>`excluded.score`,
          achievedAt: sql<number>`excluded.achieved_at`,
          resultId: sql<string | null>`excluded.result_id`,
        };
      }
      if (board.aggregation === "sum") {
        return {
          submittedAt,
          score: sql<number>`${entries}.score + excluded.score`,
          achievedAt: sql<number>`excluded.achieved_at`,
          resultId: sql<string | null>`coalesce(excluded.result_id, ${entries}.result_id)`,
        };
      }
      // `best`: take the new score only if it improves in the board's direction. On an equal score
      // both branches keep the stored achievedAt, so a replay cannot cost a player the first-to-reach
      // tiebreak they already earned.
      return {
        submittedAt,
        score: sql<number>`CASE WHEN ${improves} THEN excluded.score ELSE ${entries}.score END`,
        achievedAt: sql<number>`CASE WHEN ${improves} THEN excluded.achieved_at ELSE ${entries}.achieved_at END`,
        resultId: sql<string | null>`CASE WHEN ${improves} THEN excluded.result_id ELSE ${entries}.result_id END`,
      };
    });
    const guarded = guardNoOps ? updated.where(improves) : updated;
    return unrecorded === undefined ? guarded : guarded.where(unrecorded);
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
  };
}

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Delete an entry outright, and what every result put on it (#817). False if the player has no entry.
 *
 * The deletes take a D1 binding rather than the Kysely database because they are more than one statement,
 * and only `d1.batch()` makes them one transaction. A contribution must never outlive its entry: a void
 * reads it as "this result's points are in whatever entry this player holds now", so one left behind would
 * take points back out of the player's next entry, which never held them, or delete that entry outright.
 */
export async function deleteEntry(
  d1: D1Database,
  boardId: string,
  windowKey: string,
  userId: string,
): Promise<boolean> {
  const db = leaderboardDatabase(d1);
  const entry = db
    .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "=", windowKey)
    .where("userId", "=", userId)
    .compile();
  const contributions = db
    .deleteFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "=", windowKey)
    .where("userId", "=", userId)
    .compile();
  const [deleted] = await d1.batch([prepared(d1, entry), prepared(d1, contributions)]);
  return (deleted?.meta.changes ?? 0) > 0;
}

/**
 * Delete everything on this board in windows chronologically before `cutoffWindow`, in one transaction.
 * Returns the entries deleted.
 *
 * Everything means every row that names one of those windows: the entries, what each result contributed to
 * them, the moderation history of acts on them, and any mark waiting for the refresh. `retainDays` is a compliance limit, and a contribution
 * or a moderation's before and after hold a player's id and score as surely as the entry does. A moderation
 * kept past its window would also be audit history for an entry nobody can find any more. A cleared lock's
 * history names no window, so retention never reaches it.
 *
 * Window keys are ISO instants, so `<` is chronological. `all` is never a windowed board's key, so an
 * all-time window (which retention never targets) cannot be caught here. Each table's
 * `(boardId, windowKey, …)` index serves its delete.
 */
export async function pruneWindowsBefore(d1: D1Database, boardId: string, cutoffWindow: string): Promise<number> {
  const db = leaderboardDatabase(d1);
  const entries = db
    .deleteFrom(LEADERBOARD_ENTRIES_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "<", cutoffWindow)
    .compile();
  const contributions = db
    .deleteFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "<", cutoffWindow)
    .compile();
  const moderations = db
    .deleteFrom(LEADERBOARD_MODERATIONS_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "<", cutoffWindow)
    .compile();
  const stale = db
    .deleteFrom(LEADERBOARD_STALE_WINDOWS_TABLE)
    .where("boardId", "=", boardId)
    .where("windowKey", "<", cutoffWindow)
    .compile();
  const [deleted] = await d1.batch([
    prepared(d1, entries),
    prepared(d1, contributions),
    prepared(d1, moderations),
    prepared(d1, stale),
  ]);
  return deleted?.meta.changes ?? 0;
}
