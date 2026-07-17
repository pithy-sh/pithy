import { type Expression, type SqlBool, sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LeaderboardEntry } from "../data/entry";
import { LEADERBOARD_ENTRIES_TABLE, type LeaderboardDatabase } from "../data/tables";
import { classifyTier } from "./tiers";

/**
 * Ranked reads: top-N, my-rank, and around-me.
 *
 * Two things shape every query here.
 *
 * **No window functions.** `RANK() OVER` and `ROW_NUMBER() OVER` are undocumented on D1 — Cloudflare's
 * SQL reference neither supports nor denies them. They do execute under Miniflare, but Miniflare also
 * rejects `sqlite_version()` with `not authorized to use function`, which proves D1 runs a function
 * authorizer whose production allowlist is not visible from local. A local pass is therefore not evidence
 * about production, so ranking is built on plain `COUNT(*)` and `ORDER BY` instead. See docs/costs.md.
 *
 * **The ordering is total.** Score, then earliest `achievedAt`, then `userId`. Because no two entries can
 * tie, a rank is exactly "how many entries beat you, plus one" — so dense-vs-competition ranking never
 * arises and neither is implemented. It also means a top-N page can number its own rows from the offset
 * rather than asking the database to rank them.
 */

/**
 * Cap on a segment's member count.
 *
 * D1 allows 100 bound parameters per query, and the tightest path is `rankOf` within a segment: the
 * `rankCountQuery` binds the segment members PLUS 4 filter params (boardId, windowKey, visible, hidden)
 * PLUS 6 for the `betterThan` predicate (score twice, achieved_at twice, score+userId) — 10 of overhead.
 * A member count of 90 would land at exactly 100, with zero margin; capping at 80 keeps every segment
 * query (including the point where a future filter is added) safely under the limit.
 */
export const MAX_SEGMENT_SIZE = 80;

export interface RankedEntry {
  userId: string;
  score: number;
  achievedAt: Date;
  rank: number;
  tier: string | null;
}

export interface ReadOptions {
  /** Restrict the board to these players — a friends or cohort view over the same store, not a second board. */
  segment?: readonly string[];
}

/**
 * "Strictly better than this entry", in the board's direction.
 *
 * Spelled out as an OR-of-ANDs rather than a row-value comparison (`(score, achieved_at) > (?, ?)`)
 * because the sort directions are mixed — score descends while achievedAt ascends — and SQLite's
 * row-value shortcut only applies when every key sorts the same way.
 */
function betterThan(board: LeaderboardBoard, score: number, achievedAt: number, userId: string): Expression<SqlBool> {
  const scoreBeats = board.direction === "desc" ? sql<SqlBool>`score > ${score}` : sql<SqlBool>`score < ${score}`;
  return sql<SqlBool>`(
    ${scoreBeats}
    OR (score = ${score} AND achieved_at < ${achievedAt})
    OR (score = ${score} AND achieved_at = ${achievedAt} AND user_id < ${userId})
  )`;
}

function decorate(board: LeaderboardBoard, entry: LeaderboardEntry, rank: number): RankedEntry {
  return {
    userId: entry.userId,
    score: entry.score,
    achievedAt: entry.achievedAt,
    rank,
    tier: classifyTier(board.tiers, board.direction, entry.score),
  };
}

/**
 * A page of the board, best first. Ranks are numbered from the offset: the ordering is total, so row
 * `n` of an offset page is rank `offset + n + 1` by construction — no count, no window function.
 */
export async function topEntries(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  limit: number,
  offset = 0,
  options: ReadOptions = {},
): Promise<RankedEntry[]> {
  let query = db
    .selectFrom(LEADERBOARD_ENTRIES_TABLE)
    .selectAll()
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey)
    // Only entries the player consented to show and a moderator has not hidden are ever ranked.
    .where("visible", "=", 1)
    .where("hidden", "=", 0);
  if (options.segment) {
    if (options.segment.length === 0) return [];
    query = query.where("userId", "in", [...options.segment]);
  }
  const rows = await query
    .orderBy("score", board.direction === "desc" ? "desc" : "asc")
    .orderBy("achievedAt", "asc")
    .orderBy("userId", "asc")
    .limit(limit)
    .offset(offset)
    .execute();
  return rows.map((row, index) => decorate(board, LeaderboardEntry.parse(row), offset + index + 1));
}

/**
 * The player's own rank, or null if they have no visible entry.
 *
 * When `materialized` is set the stored rank column is read — one indexed point read, and the reason
 * `rank: { materialize }` exists. Otherwise the rank is counted live: correct always, free under ~10k
 * players, and O(rank position) in billed rows because D1 bills rows *scanned*, not returned. A stale
 * materialized rank is deliberate; the player's own score beside it is always live.
 */
export async function rankOf(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  userId: string,
  materialized: boolean,
  options: ReadOptions = {},
): Promise<{ entry: LeaderboardEntry; rank: number | null; tier: string | null } | null> {
  const row = await db
    .selectFrom(LEADERBOARD_ENTRIES_TABLE)
    .selectAll()
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey)
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!row) return null;
  const entry = LeaderboardEntry.parse(row);
  const tier = classifyTier(board.tiers, board.direction, entry.score);
  // A hidden or unconsented entry is not on the board, so it has no rank — but the player still gets
  // their own score back, which is why this is a null rank rather than a 404.
  if (!entry.visible || entry.hidden) return { entry, rank: null, tier };
  // A segment view has no meaningful materialized rank: the stored column ranks the whole board.
  if (materialized && !options.segment) return { entry, rank: entry.rank ?? null, tier };
  if (options.segment?.length === 0) return { entry, rank: null, tier };

  const counted = await rankCountQuery(db, board, windowKey, entry, options).executeTakeFirst();
  return { entry, rank: Number(counted?.better ?? 0) + 1, tier };
}

/**
 * The live-rank count: how many visible entries beat this one. Exported so `plan.workers.test.ts` can
 * compile the real query and read D1's own `EXPLAIN QUERY PLAN` for it — a plan test that hand-wrote the
 * SQL would only prove that the hand-written SQL is indexed.
 */
export function rankCountQuery(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  entry: Pick<LeaderboardEntry, "score" | "achievedAt" | "userId">,
  options: ReadOptions = {},
) {
  let query = db
    .selectFrom(LEADERBOARD_ENTRIES_TABLE)
    .select(({ fn }) => fn.countAll<number>().as("better"))
    .where("boardId", "=", board.key)
    .where("windowKey", "=", windowKey)
    // Only entries the player consented to show and a moderator has not hidden are ever ranked.
    .where("visible", "=", 1)
    .where("hidden", "=", 0);
  if (options.segment && options.segment.length > 0) {
    query = query.where("userId", "in", [...options.segment]);
  }
  return query.where(betterThan(board, entry.score, entry.achievedAt.getTime(), entry.userId));
}

/**
 * The slice of the board centred on a player: `radius` entries either side of them.
 *
 * Built on the total ordering — find the player's rank, then page the board around it — so it needs no
 * second index and no window function. Rank is always counted live here even when the board is
 * materialized: an "around me" page whose neighbours came from a stale rank column would show players
 * who are no longer next to you.
 */
export async function entriesAround(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  userId: string,
  radius: number,
  options: ReadOptions = {},
): Promise<RankedEntry[]> {
  const own = await rankOf(db, board, windowKey, userId, false, options);
  if (!own || own.rank === null) return [];
  const offset = Math.max(0, own.rank - radius - 1);
  return topEntries(db, board, windowKey, radius * 2 + 1, offset, options);
}
