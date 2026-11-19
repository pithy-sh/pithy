// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { INSTANCE_PAGE_SIZE, instancePage } from "../board/instances";
import type { LeaderboardBoard, LeaderboardConfig } from "../config/config";
import { materializeSchedule } from "../config/config";
import { type LeaderboardDatabase, leaderboardDatabase } from "../data/tables";
import { type PruneOutcome, pruneBoards } from "../retention/prune";
import { windowKeyAt } from "../window/schedule";
import { type RefreshResult, refreshWindowRanks } from "./materialize";
import { clearStale, type StaleWindow, staleWindows } from "./stale";

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
 * One board's contribution to a rank pass: what the refresh did, or that it could not be done.
 *
 * The state rides on the value. A board that threw is not a board that ranked nobody — `ranked: 0` is a
 * real answer about an empty window — so the numbers live behind `refreshed` and a consumer reaches them
 * only by narrowing. Forgetting the sick board is a type error rather than a zero on a dashboard.
 */
export type BoardRefresh =
  | ({
      /** This board's window was ranked: the open one, or a closed one an act or a void marked stale. */
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
  /**
   * One entry per window the refresh pass touched: each materialized board's open window, then each closed
   * window an act or a void marked stale. Empty when rank is live.
   */
  refreshed: BoardRefresh[];
}

/**
 * The boards a refresh pass must rank, given every board there is: all of them when rank is materialized,
 * none when it is live, because a live board computes rank per request.
 */
export function materializedBoards(config: LeaderboardConfig, boards: readonly LeaderboardBoard[]): LeaderboardBoard[] {
  return materializeSchedule(config) === undefined ? [] : [...boards];
}

/**
 * Where a rank Workflow run picks up a pass the run before it started.
 *
 * A pass walks the configured boards and one page of instances, then, when more instances follow, starts the
 * next run with this as its params and leaves the lock with it. Every run of one pass shares its holder and
 * its clock, so the pass ranks against one `now` and no cron fire can start a second pass beside it.
 */
export const RankPassContinuation = z
  .object({
    holder: z.string().min(1).describe("The lock holder token of the pass, which every run of it holds the lock as."),
    nowMs: z.number().int().describe("The pass's clock, in ms-epoch: every run ranks the windows open at this moment."),
    after: z.string().min(1).describe("The last instance key the previous run read; this run's page starts after it."),
    run: z.number().int().min(1).describe("This run's position in the pass, counting the cron-started run as 0."),
  })
  .describe("The params a rank Workflow run hands to the run that continues its pass.");
export type RankPassContinuation = z.output<typeof RankPassContinuation>;

/** Two sweeps' outcomes as one: their deletions added, and every board either could not prune. */
function mergePruned(a: PruneOutcome, b: PruneOutcome): PruneOutcome {
  const deleted =
    (a.state === "pruned" ? a.deleted : a.counted.deleted) + (b.state === "pruned" ? b.deleted : b.counted.deleted);
  const unpruned = [...(a.state === "partial" ? a.unpruned : []), ...(b.state === "partial" ? b.unpruned : [])];
  return unpruned.length === 0 ? { state: "pruned", deleted } : { state: "partial", counted: { deleted }, unpruned };
}

/**
 * **Every contributor here is degraded, and none of them is load-bearing.**
 *
 * The sweep runs first so the refresh never spends a chunk ranking rows about to be deleted — an
 * efficiency, not a precondition. A board whose prune throws keeps its old rows a while longer and ranks
 * correctly regardless, so the sweep failing is no reason to leave every board's ranks stale. And boards
 * are independent of each other by construction: one board's entries, windows and ranks are its own, so a
 * board that will not rank has no claim on any other board's pass.
 *
 * So one sick board costs its own line. What it must never do is read as a board that ranked nobody.
 */
export async function runRankPass(
  d1: D1Database,
  config: LeaderboardConfig,
  now: Date,
  instancePageSize: number = INSTANCE_PAGE_SIZE,
): Promise<RankPassResult> {
  const db = leaderboardDatabase(d1);
  // The configured boards, then the instances a page at a time, so the pass never holds the whole instance
  // set, however large it grows.
  let result = await passBoards(d1, db, config, config.boards, now);
  for (let after: string | null = null; ; ) {
    const page = await instancePage(db, config, after, instancePageSize);
    if (page.boards.length > 0) {
      const next = await passBoards(d1, db, config, page.boards, now);
      result = { pruned: mergePruned(result.pruned, next.pruned), refreshed: [...result.refreshed, ...next.refreshed] };
    }
    if (page.next === null) return result;
    after = page.next;
  }
}

/** The sweep, then the refresh, over one set of boards. */
async function passBoards(
  d1: D1Database,
  db: LeaderboardDatabase,
  config: LeaderboardConfig,
  boards: readonly LeaderboardBoard[],
  now: Date,
): Promise<RankPassResult> {
  const pruned = await pruneBoards(d1, boards, now);

  const refreshed: BoardRefresh[] = [];
  for (const board of materializedBoards(config, boards)) {
    // The open window, every pass. A closed window stopped moving when it closed, so the pass that ran
    // while it was open left it final — unless an act or a void moved it since, and marked it stale.
    const open = windowKeyAt(board.window, now);
    let marked: StaleWindow[];
    try {
      marked = await staleWindows(db, board.key);
    } catch {
      // The board's own reads are failing; its refresh would too. One line for it, as below.
      refreshed.push({ state: "unavailable", board: board.key, window: open });
      continue;
    }
    const windows = [open, ...marked.map((m) => m.windowKey).filter((key) => key !== open)];
    for (const window of windows) {
      let result: RefreshResult;
      try {
        result = await refreshWindowRanks(db, board, window);
        const mark = marked.find((m) => m.windowKey === window);
        if (mark) await clearStale(db, board.key, mark);
      } catch {
        // No binding. A refresh throws out of D1 with a query and an entry's identifiers in it, and this
        // result is rendered wherever a caller renders it — so what survives is the board key and the
        // window, both of which are the adopter's own configuration. An uncleared mark is retried next pass.
        refreshed.push({ state: "unavailable", board: board.key, window });
        continue;
      }
      refreshed.push({ state: "refreshed", board: board.key, window, ...result });
    }
  }
  return { pruned, refreshed };
}
