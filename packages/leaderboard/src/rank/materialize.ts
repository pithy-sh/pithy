// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import type { LeaderboardBoard } from "../config/config";
import { LEADERBOARD_ENTRIES_TABLE, type LeaderboardDatabase } from "../data/tables";

/**
 * The rank refresh pass — what `rank: { materialize }` buys and what it costs.
 *
 * A full-table rank rewrite is the obvious implementation and the wrong one. D1 executes one query at a
 * time per database and caps a query at 30 seconds; a single `UPDATE` over a large board would hold the
 * only thread for its whole duration and risk the documented `overloaded` error for every live
 * submission behind it. So the pass is chunked: many small, bounded statements the runtime can
 * interleave with real traffic.
 *
 * Two hard limits shape the chunk size:
 *
 *   - **100 bound parameters per query.** Each row in a bulk update costs three (`WHEN id THEN rank`,
 *     plus the id again in the `IN` list), and the board and window cost one each. Hence 32 rows.
 *   - **30 seconds per query**, which the chunk size keeps a long way off.
 *
 * Chunks walk the board by keyset, not by `OFFSET`: an offset page makes SQLite count past every row it
 * skips, so an offset walk is quadratic in billed rows — the very cost `materialize` exists to avoid.
 *
 * Cloudflare documents no rank-materialization pattern. All of this is adopter-built, which is exactly
 * why it lives in the package instead of in every adopter's repo.
 */

/** D1's cap. Cloudflare documents this as a hard per-query limit. */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * Rows per chunk: three bound parameters each, plus the board key and window key, under the cap.
 * `(32 * 3) + 2 = 98`.
 */
export const RANK_CHUNK_SIZE = 32;

/** The last entry a chunk ranked — where the next chunk (or the next batch's step) resumes. */
export interface Keyset {
  score: number;
  achievedAt: number;
  userId: string;
}

/**
 * Narrow a selected `achievedAt` to its stored epoch.
 *
 * The column's decode-side input is a union (`number | string | Date`) so the codec stays
 * encode-compatible, but a chunk selects raw columns rather than parsing whole rows — D1 always hands
 * back the stored integer. This keeps the keyset arithmetic honest without paying to parse every row.
 */
function toEpoch(value: number | string | Date): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

export interface RefreshResult {
  /** The cumulative number of entries ranked, including any `startRank` carried in from a prior batch. */
  ranked: number;
  /** How many chunks ran in this call. */
  chunks: number;
  /** True when the board is fully ranked; false when `maxChunks` stopped this batch mid-board. */
  complete: boolean;
  /**
   * Where the next batch resumes, or null when the board is complete. Passing this back as `resumeAfter`
   * (with `startRank` set to `ranked`) continues the pass exactly where it left off — the seam that makes
   * a board rankable across many bounded steps of a Workflow, rather than one unbounded invocation.
   */
  cursor: Keyset | null;
}

export interface RefreshOptions {
  /** Rows per chunk. Defaults to {@link RANK_CHUNK_SIZE}; lower it only to be gentler on a hot database. */
  chunkSize?: number;
  /** Stop cleanly once this many chunks have run, whether or not the board is finished. Default: no cap. */
  maxChunks?: number;
  /** Resume the keyset walk after this entry — the `cursor` a prior batch returned. */
  resumeAfter?: Keyset;
  /** The rank already assigned before this batch, so numbering continues rather than restarting at 1. */
  startRank?: number;
}

/**
 * Recompute the stored rank for one board and window, best first.
 *
 * Ranks are positions in the total ordering, so a chunk needs no counting — the first chunk's first row
 * is rank 1 and every chunk continues the count. The pass is **resumable**: with no `maxChunks` it ranks
 * the whole board; with a `maxChunks` batch cap it ranks that many chunks, returns a `cursor`, and the
 * caller feeds the cursor (and `startRank: ranked`) back to continue. That is what lets a board of any
 * size be ranked across a series of bounded, individually-durable Workflow steps — there is no longer a
 * per-invocation ceiling on how many entries a board can have.
 */
export async function refreshWindowRanks(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  windowKey: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const chunkSize = options.chunkSize ?? RANK_CHUNK_SIZE;
  const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
  const descending = board.direction === "desc";

  let after: Keyset | undefined = options.resumeAfter;
  let ranked = options.startRank ?? 0;
  let chunks = 0;

  while (chunks < maxChunks) {
    let query = db
      .selectFrom(LEADERBOARD_ENTRIES_TABLE)
      .select(["id", "score", "achievedAt", "userId"])
      .where("boardId", "=", board.key)
      .where("windowKey", "=", windowKey)
      .where("visible", "=", 1)
      .where("hidden", "=", 0);

    if (after) {
      // Keyset resume: strictly worse than the last row ranked, in the board's total ordering. Spelled
      // out as an OR-of-ANDs for the same reason as the rank predicate — the sort directions are mixed.
      const scoreWorse = descending ? sql`score < ${after.score}` : sql`score > ${after.score}`;
      query = query.where(
        sql<boolean>`(
          ${scoreWorse}
          OR (score = ${after.score} AND achieved_at > ${after.achievedAt})
          OR (score = ${after.score} AND achieved_at = ${after.achievedAt} AND user_id > ${after.userId})
        )`,
      );
    }

    const rows = await query
      .orderBy("score", descending ? "desc" : "asc")
      .orderBy("achievedAt", "asc")
      .orderBy("userId", "asc")
      .limit(chunkSize)
      .execute();

    if (rows.length === 0) return { ranked, chunks, complete: true, cursor: null };

    // One bulk UPDATE per chunk: `SET rank = CASE id WHEN ? THEN ? … END WHERE id IN (…)`. Row-at-a-time
    // updates would be correct too, and would cost one round trip each on a single-threaded database.
    const ids = rows.map((row) => row.id);
    let cases = sql``;
    rows.forEach((row, index) => {
      cases = sql`${cases} WHEN ${row.id} THEN ${ranked + index + 1}`;
    });
    await db
      .updateTable(LEADERBOARD_ENTRIES_TABLE)
      .set({ rank: sql<number>`CASE id ${cases} END` })
      .where("id", "in", ids)
      .execute();

    ranked += rows.length;
    chunks += 1;
    const last = rows[rows.length - 1];
    if (!last) break;
    after = { score: last.score, achievedAt: toEpoch(last.achievedAt), userId: last.userId };

    // A short chunk means the board ran out, so there is nothing left to resume into.
    if (rows.length < chunkSize) return { ranked, chunks, complete: true, cursor: null };
  }

  // The batch cap stopped us mid-board: hand back the cursor so the next step resumes here.
  return { ranked, chunks, complete: false, cursor: after ?? null };
}
