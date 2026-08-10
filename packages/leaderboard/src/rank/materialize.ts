// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { boundParameterBudget, chunkRowsByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
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
 * A chunk is a **pacing** unit: how much of the board one keyset step walks, kept well inside D1's
 * 30-second per-query limit. It is no longer also the width of a statement — the bulk update sizes
 * itself against D1's bound-parameter cap through core's arithmetic, so a chunk of any size is written
 * in as many statements as it takes. That separation is the fix for #250: `chunkSize` was unvalidated,
 * and `chunkSize: 40` bound 120 and broke the pass with no warning that a limit was even involved.
 *
 * Chunks walk the board by keyset, not by `OFFSET`: an offset page makes SQLite count past every row it
 * skips, so an offset walk is quadratic in billed rows — the very cost `materialize` exists to avoid.
 *
 * Cloudflare documents no rank-materialization pattern. All of this is adopter-built, which is exactly
 * why it lives in the package instead of in every adopter's repo.
 */

/**
 * What one ranked row costs the bulk update: `WHEN id`, `THEN rank`, and the id again in the `IN` list.
 *
 * The cap itself is not restated here. It was, and a second copy of a platform limit is how a limit goes
 * stale in one place and not the other — `MAX_BOUND_PARAMETERS` lives in `@pithy-sh/core`, once.
 */
export const RANK_PARAMETERS_PER_ROW = 3;

/**
 * Rows per chunk by default: as many as one update statement can carry, from core's budget.
 *
 * Derived rather than written out, so it moves if the platform does. Any other size works — the update
 * chunks itself — and this is simply the size at which a chunk is exactly one statement.
 */
export const RANK_CHUNK_SIZE = Math.floor(boundParameterBudget(0) / RANK_PARAMETERS_PER_ROW);

/**
 * Chunks a refresh ranks before it checkpoints its cursor. `2000 * 33` is ~66k entries per Workflow step.
 *
 * The batch cap is stated here rather than in `worker.entry.ts`, which is the module that passes it as
 * `maxChunks`. That module imports `cloudflare:workers`, so anything it exports is unreachable from a
 * plain Node process, and a constant that reads as ordinary is exactly how #172 and #180 happened twice:
 * a Node-side caller imports the number, gets workerd behind it, and the failure surfaces as
 * `Could not load pithy.config.ts` — naming the config rather than the import. A pure value belongs in a
 * pure module. `configEntrypoints.test.ts` is what holds that.
 */
export const REFRESH_BATCH_CHUNKS = 2000;

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
  /**
   * Rows per keyset step. Defaults to {@link RANK_CHUNK_SIZE}; lower it to be gentler on a hot database.
   *
   * It carries no bound-parameter ceiling — the update chunks itself — so the only thing refused is a
   * value that is not a count. A `chunkSize` of 0 used to report a board complete having ranked nobody.
   */
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
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new ValidationError({
      message: "The rank refresh was asked for an impossible chunk size.",
      action: "Pass a whole number of one or more, or omit chunkSize for the default.",
      detail: `refreshWindowRanks received chunkSize=${chunkSize}; it must be a positive integer.`,
    });
  }
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

    // One bulk UPDATE per statement's worth of rows: `SET rank = CASE id WHEN ? THEN ? … END WHERE id
    // IN (…)`. Row-at-a-time updates would be correct too, and would cost one round trip each on a
    // single-threaded database. How many rows fit is core's arithmetic, not a number written out here,
    // so a chunk larger than one statement is simply written as several.
    let written = 0;
    for (const group of chunkRowsByBoundParameters(rows, RANK_PARAMETERS_PER_ROW)) {
      const base = ranked + written;
      let cases = sql``;
      group.forEach((row, index) => {
        cases = sql`${cases} WHEN ${row.id} THEN ${base + index + 1}`;
      });
      await db
        .updateTable(LEADERBOARD_ENTRIES_TABLE)
        .set({ rank: sql<number>`CASE id ${cases} END` })
        .where(
          "id",
          "in",
          group.map((row) => row.id),
        )
        .execute();
      written += group.length;
    }

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
