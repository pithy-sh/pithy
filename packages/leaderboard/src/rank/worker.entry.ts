// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { LeaderboardConfig } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { pruneBoards } from "../retention/prune";
import { windowKeyAt } from "../window/schedule";
import { acquireRefreshLock, releaseRefreshLock } from "./lock";
import { type Keyset, REFRESH_BATCH_CHUNKS, type RefreshResult, refreshWindowRanks } from "./materialize";
import { materializedBoards } from "./worker";

/**
 * The leaderboard rank refresh, as a cron-triggered Cloudflare Workflow.
 *
 * Why a Workflow rather than a plain `scheduled()` pass: a Worker invocation is wall-clock bounded, so
 * an earlier design capped each run at ~64k entries and re-ranked from the top every tick — a board
 * bigger than that never fully ranked. A Workflow step has unlimited wall-clock and does not burn CPU
 * while awaiting D1 (all our work is D1 I/O), so a board of any size ranks across a series of bounded,
 * individually-durable steps. Each step checkpoints the keyset cursor; a crash resumes from the last
 * completed step instead of restarting. The 64k ceiling is gone.
 *
 * At-most-one at a time: a refresh takes a D1 advisory lock before it starts and releases it when done.
 * If a cron fires again while a refresh is still running (a cron faster than the refresh takes), the
 * second instance cannot take the lock and skips — so two passes never interleave their chunked writes
 * into an incoherent rank set. A crashed instance's lock ages out (see `lock.ts`) so the next fire
 * reclaims it.
 *
 * Why it does NOT require a dedicated worker: this is a Workflow class plus a `scheduled()` handler plus
 * one cron trigger. `pithy add leaderboard` deploys it as its own small worker by default (the template
 * in `wrangler.jsonc`), but the same three pieces can be merged into the adopter's app worker — the
 * capability contributes the Workflow through its manifest. A cron trigger is the one hard requirement;
 * a separate worker is not.
 *
 * Cost: on Workers Paid this stays inside the free allowances at any realistic cadence — a run is a
 * handful of steps (one prune + a few per board), storage is zero (all state is D1), and idle/awaiting
 * steps incur no CPU. Even firing every minute is well under the 500k-steps/month and 10M-requests/month
 * included tiers.
 */

interface RankWorkerEnv {
  DB: D1Database;
  /** The resolved leaderboard config, as JSON. The board set is config; this worker needs the same one. */
  LEADERBOARD_CONFIG: string;
  /** Optional override for how long a held refresh lock stays valid before it is reclaimed (see lock.ts). */
  LEADERBOARD_LOCK_STALE_MS?: string;
  /** The Workflow binding — this worker's own class, used by `scheduled()` to start an instance. */
  RANK_REFRESH: { create(options?: { id?: string }): Promise<unknown> };
}

export class RankRefreshWorkflow extends WorkflowEntrypoint<RankWorkerEnv, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const config = LeaderboardConfig.parse(JSON.parse(this.env.LEADERBOARD_CONFIG));
    const db = leaderboardDatabase(this.env.DB);
    const staleMs = this.env.LEADERBOARD_LOCK_STALE_MS ? Number(this.env.LEADERBOARD_LOCK_STALE_MS) : undefined;

    // Mint this instance's identity and its clock ONCE, in a memoized step, and read them from the step's
    // return value. A replay does not re-run the step body, so it reuses the same holder token and the
    // same `now` — recomputing `now` could cross a window boundary mid-refresh, and a fresh token would
    // orphan the lock.
    const ctx: { holder: string; nowMs: number } = await step.do("refresh-context", async () => ({
      holder: crypto.randomUUID(),
      nowMs: Date.now(),
    }));
    const now = new Date(ctx.nowMs);

    // Acquire and release run OUTSIDE steps, deliberately — the one place this file does side effects
    // outside a step. Both are idempotent D1 ops, and re-running them on every replay is exactly what
    // keeps the lock state honest: acquire re-validates against live D1 (an instance whose stale lock was
    // reclaimed while it was interrupted re-checks, sees the lock is no longer its own, and stands down,
    // instead of resuming on a memoized "acquired" and writing concurrently); release re-converges the
    // same way. A memoized acquire/release step would instead freeze a stale decision across the replay.
    if (!(await acquireRefreshLock(db, ctx.holder, now, staleMs))) return;

    try {
      // Prune first, in its own durable step, so the refresh never ranks rows about to be deleted.
      await step.do("prune", () => pruneBoards(db, config.boards, now));

      for (const board of materializedBoards(config)) {
        // Only the open window is refreshed; a closed window's ranks were finalized while it was open.
        const window = windowKeyAt(board.window, now);
        let cursor: Keyset | null = null;
        let startRank = 0;
        let batch = 0;
        // One step per batch of ~64k entries, threading the cursor. A board of any size completes across
        // however many steps it needs; each is independently retried by the Workflow runtime.
        for (;;) {
          const from: Keyset | undefined = cursor ?? undefined;
          const result: RefreshResult = await step.do(`refresh:${board.key}:${batch}`, () =>
            refreshWindowRanks(db, board, window, {
              maxChunks: REFRESH_BATCH_CHUNKS,
              resumeAfter: from,
              startRank,
            }),
          );
          if (result.complete) break;
          cursor = result.cursor;
          startRank = result.ranked;
          batch += 1;
          // A batch that stopped without a cursor cannot resume — bail rather than loop forever.
          if (!cursor) break;
        }
      }
    } finally {
      // Release even if a step threw, so a failure does not wedge the lock until it ages out. Outside a
      // step (see the acquire note) so a replay re-releases rather than skipping a memoized release.
      await releaseRefreshLock(db, ctx.holder);
    }
  }
}

export default {
  /**
   * Cron entry: start one rank-refresh Workflow instance per fire. Each instance re-ranks from the top;
   * the checkpointing is within an instance (resume on crash), not across fires (a fire is a fresh full
   * refresh). If a fire lands while a previous refresh is still running, the new instance takes no lock
   * and exits immediately, so overlapping instances never write concurrently — see the lock acquisition
   * in `run()` above.
   */
  async scheduled(_controller: unknown, env: RankWorkerEnv): Promise<void> {
    await env.RANK_REFRESH.create();
  },
};
