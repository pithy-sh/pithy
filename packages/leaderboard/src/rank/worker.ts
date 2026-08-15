// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { LeaderboardBoard, LeaderboardConfig } from "../config/config";
import { materializeSchedule } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { type PruneOutcome, pruneBoards } from "../retention/prune";
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
/**
 * One board's contribution to a rank pass: what the refresh did, or that it could not be done (#371).
 *
 * The state rides on the value. A board that threw is not a board that ranked nobody — `ranked: 0` is a
 * real answer about an empty window — so the numbers live behind `refreshed` and a consumer reaches them
 * only by narrowing. Forgetting the sick board is a type error rather than a zero on a dashboard.
 */
export type BoardRefresh =
  | ({
      /** This board's open window was ranked. */
      state: "refreshed";
      /** The board's key, as its config declares it. */
      board: string;
      /** The window key that was ranked. */
      window: string;
    } & RefreshResult)
  | {
      /** This board's refresh threw. Its ranks are whatever the previous pass left. */
      state: "unavailable";
      /** The board's key, as its config declares it. */
      board: string;
      /** The window key the pass was attempting. */
      window: string;
    };

export interface RankPassResult {
  /** What the retention sweep deleted, and whether it reached every board. */
  pruned: PruneOutcome;
  /** One entry per materialized board the refresh pass touched. Empty when rank is live. */
  refreshed: BoardRefresh[];
}

/** The boards a refresh pass must rank: only materialized ones. Live boards compute rank per request. */
export function materializedBoards(config: LeaderboardConfig): LeaderboardBoard[] {
  return materializeSchedule(config) === undefined ? [] : config.boards;
}

/**
 * **Every contributor here is degraded, and none of them is load-bearing (#371).**
 *
 * The sweep runs first so the refresh never spends a chunk ranking rows about to be deleted — an
 * efficiency, not a precondition. A board whose prune throws keeps its old rows a while longer and ranks
 * correctly regardless, so the sweep failing is no reason to leave every board's ranks stale. And boards
 * are independent of each other by construction: one board's entries, windows and ranks are its own, so a
 * board that will not rank has no claim on any other board's pass.
 *
 * So one sick board costs its own line. What it must never do is read as a board that ranked nobody.
 */
export async function runRankPass(d1: D1Database, config: LeaderboardConfig, now: Date): Promise<RankPassResult> {
  const db = leaderboardDatabase(d1);
  const pruned = await pruneBoards(db, config.boards, now);

  const refreshed: BoardRefresh[] = [];
  for (const board of materializedBoards(config)) {
    // Only the open window is refreshed. A closed window's ranks stopped moving when it closed, so the
    // pass that ran while it was open already left them final.
    const window = windowKeyAt(board.window, now);
    let result: RefreshResult;
    try {
      result = await refreshWindowRanks(db, board, window);
    } catch {
      // No binding. A refresh throws out of D1 with a query and an entry's identifiers in it, and this
      // result is rendered wherever a caller renders it — so what survives is the board key and the
      // window, both of which are the adopter's own configuration.
      refreshed.push({ state: "unavailable", board: board.key, window });
      continue;
    }
    refreshed.push({ state: "refreshed", board: board.key, window, ...result });
  }
  return { pruned, refreshed };
}
