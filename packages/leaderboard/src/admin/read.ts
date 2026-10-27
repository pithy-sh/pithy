// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { type SqlBool, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardEntry } from "../data/entry";
import { LeaderboardLock } from "../data/lock";
import { LEADERBOARD_ENTRIES_TABLE, LEADERBOARD_LOCKS_TABLE, type LeaderboardDatabase } from "../data/tables";
import { rankCountQuery } from "../rank/query";

/**
 * The management read model (#817) — the queries behind the control-plane reads, and nothing else.
 *
 * **Every entry, in the board's own order.** The player reads rank only what is visible and not hidden; a
 * moderator has to see the rest too, or nothing could ever be unhidden. So this walks every entry in the
 * window by the same total ordering the ranked reads use — score in the board's direction, then earliest
 * `achievedAt`, then `userId` — and a hidden or unconsented entry sits where its score would put it, with
 * no rank.
 *
 * **Keyset, never offset.** An offset shifts under a reader the moment a score lands, and on a live board
 * one always is. The cursor is the last row's position in that ordering, through core's cursor helper:
 * `sort` is the score, `id` carries the two tiebreaks.
 *
 * **Rank is counted, not read.** The first ranked row of a page is counted live — the same count a
 * player's own rank uses — and every ranked row after it is one more, because the ordering is total and an
 * unranked row takes no position. A materialized board's stored rank may lag; a moderator deciding about
 * an entry should not.
 */

/** Where an entry sits in the board's ordering. */
export interface EntryPosition {
  score: number;
  /** `achievedAt`, as its stored ms-epoch. */
  achievedAt: number;
  userId: string;
}

/** Encode an entry's position as a core page cursor: the score, and the two tiebreaks in `id`. */
export function entryCursor(entry: Pick<LeaderboardEntry, "score" | "achievedAt" | "userId">): PageCursor {
  return { sort: entry.score, id: `${entry.achievedAt.getTime()}:${entry.userId}` };
}

/**
 * The position a page resumes after, or undefined for a first page.
 *
 * A cursor that is not one of ours — another listing's, a truncated value, a guess — resolves to the first
 * page rather than an error, as core's `decodeCursor` promises, so a bad cursor is never a probe.
 */
export function resumeAfter(cursor: string | undefined): EntryPosition | undefined {
  const decoded = decodeCursor(cursor);
  if (!decoded || typeof decoded.sort !== "number" || typeof decoded.id !== "string") return undefined;
  const split = decoded.id.indexOf(":");
  if (split < 1) return undefined;
  const achievedAt = Number(decoded.id.slice(0, split));
  if (!Number.isSafeInteger(achievedAt)) return undefined;
  return { score: decoded.sort, achievedAt, userId: decoded.id.slice(split + 1) };
}

/** "Strictly after this position" in the board's ordering. */
function after(board: LeaderboardBoard, position: EntryPosition) {
  const score = sql.ref("score");
  const achievedAt = sql.ref("achievedAt");
  const userId = sql.ref("userId");
  const worse =
    board.direction === "desc"
      ? sql<SqlBool>`${score} < ${position.score}`
      : sql<SqlBool>`${score} > ${position.score}`;
  return sql<SqlBool>`(
    ${worse}
    OR (${score} = ${position.score} AND ${achievedAt} > ${position.achievedAt})
    OR (${score} = ${position.score} AND ${achievedAt} = ${position.achievedAt} AND ${userId} > ${position.userId})
  )`;
}

/** What {@link listEntries} accepts. */
export interface EntriesQuery {
  cursor?: string;
  limit?: number;
  /** One player's entry only. */
  userId?: string;
  /** Hidden entries only (`true`), or entries not hidden (`false`). */
  hidden?: boolean;
}

/** One entry and its live rank, or null while it is not on the board. */
export interface AdminEntry {
  entry: LeaderboardEntry;
  rank: number | null;
}

/** One page of a window, in the board's order, hidden entries in place. */
export async function listEntries(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  query: EntriesQuery = {},
): Promise<{ items: AdminEntry[]; nextCursor: string | null }> {
  const limit = pageLimit(query.limit);
  const position = resumeAfter(query.cursor);
  let selection = db
    .selectFrom(LEADERBOARD_ENTRIES_TABLE)
    .selectAll()
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey);
  if (query.userId !== undefined) selection = selection.where("userId", "=", query.userId);
  if (query.hidden !== undefined) selection = selection.where("hidden", "=", query.hidden ? 1 : 0);
  if (position) selection = selection.where(after(board, position));
  const rows = await selection
    .orderBy("score", board.direction === "desc" ? "desc" : "asc")
    .orderBy("achievedAt", "asc")
    .orderBy("userId", "asc")
    // One more than asked for: how "is there another page" is answered without a COUNT.
    .limit(limit + 1)
    .execute();
  const page = toPage(
    rows.map((row) => LeaderboardEntry.parse(row)),
    limit,
    entryCursor,
  );

  const items: AdminEntry[] = [];
  let next: number | null = null;
  for (const entry of page.items) {
    if (!entry.visible || entry.hidden) {
      items.push({ entry, rank: null });
      continue;
    }
    if (next === null) {
      const counted = await rankCountQuery(db, board, windowKey, entry).executeTakeFirst();
      next = Number(counted?.better ?? 0) + 1;
    }
    items.push({ entry, rank: next });
    next += 1;
  }
  return { items, nextCursor: page.nextCursor };
}

/** Every lock held now. One row at most today: `rank-refresh`. */
export async function listLocks(db: LeaderboardDatabase): Promise<LeaderboardLock[]> {
  const rows = await db.selectFrom(LEADERBOARD_LOCKS_TABLE).selectAll().orderBy("name").execute();
  return rows.map((row) => LeaderboardLock.parse(row));
}
