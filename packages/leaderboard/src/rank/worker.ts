import type { D1Database } from "@cloudflare/workers-types";
import type { LeaderboardBoard, LeaderboardConfig } from "../config/config";
import { materializeSchedule } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { pruneBoards } from "../retention/prune";
import { windowKeyAt } from "../window/schedule";
import { type RefreshResult, refreshWindowRanks } from "./materialize";

/**
 * The rank pass, in process: the retention sweep, then the rank refresh, each board ranked to completion.
 *
 * This is the reusable core the {@link RankRefreshWorkflow} drives step by step, and a standalone entry
 * point for a caller who wants the whole pass in one call (tests, a simple scheduled handler). It runs
 * every board to completion — there is no per-invocation chunk cap, so no board-size ceiling. The
 * Workflow adds durability and per-board checkpointing on top of these same primitives; it does not need
 * a different pass.
 *
 * Order matters. Pruning first means the refresh never spends a chunk ranking rows about to be deleted,
 * and a board whose retention just dropped a window does not briefly publish ranks for it.
 */
export interface RankPassResult {
  /** Entries deleted by the retention sweep. */
  pruned: number;
  /** One result per materialized board the refresh pass touched. Empty when rank is live. */
  refreshed: Array<{ board: string; window: string } & RefreshResult>;
}

/** The boards a refresh pass must rank: only materialized ones. Live boards compute rank per request. */
export function materializedBoards(config: LeaderboardConfig): LeaderboardBoard[] {
  return materializeSchedule(config) === undefined ? [] : config.boards;
}

export async function runRankPass(d1: D1Database, config: LeaderboardConfig, now: Date): Promise<RankPassResult> {
  const db = leaderboardDatabase(d1);
  const pruned = await pruneBoards(db, config.boards, now);

  const refreshed: RankPassResult["refreshed"] = [];
  for (const board of materializedBoards(config)) {
    // Only the open window is refreshed. A closed window's ranks stopped moving when it closed, so the
    // pass that ran while it was open already left them final.
    const window = windowKeyAt(board.window, now);
    const result = await refreshWindowRanks(db, board, window);
    refreshed.push({ board: board.key, window, ...result });
  }
  return { pruned, refreshed };
}
