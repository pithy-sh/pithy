// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database } from "@cloudflare/workers-types";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { instancePage } from "../board/instances";
import { LeaderboardConfig, resolveBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { pruneBoards } from "../retention/prune";
import { windowKeyAt } from "../window/schedule";
import { acquireRefreshLock, releaseRefreshLock, requireLockStaleMs } from "./lock";
import { type Keyset, REFRESH_BATCH_CHUNKS, type RefreshResult, refreshWindowRanks } from "./materialize";
import { leaderboardWorkflowRetry } from "./retryPolicy";
import { clearStale, type StaleWindow, staleWindows } from "./stale";
import { materializedBoards, RankPassContinuation } from "./worker";

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
 * Bounded however many instances there are: a family's instances have no ceiling, so one run walks the
 * configured boards and one page of instances (`INSTANCE_PAGE_SIZE`), then, when more follow, starts the
 * next run with a {@link RankPassContinuation} and hands it the lock. Each run's step count and persisted
 * state stay inside a Workflow instance's limits; a pass over many instances is a chain of runs, all
 * ranking against the clock the first one minted, and no cron fire can start a second pass beside it.
 *
 * Cost: on Workers Paid this stays inside the free allowances at any realistic cadence for a set of
 * configured boards — a run is a handful of steps (one prune + a few per board), storage is zero (all state
 * is D1), and idle/awaiting steps incur no CPU. Instances add about two steps each per pass.
 */

interface RankWorkerEnv {
  DB: D1Database;
  /** The resolved leaderboard config, as JSON. The board set is config; this worker needs the same one. */
  LEADERBOARD_CONFIG: string;
  /** Optional override for how long a held refresh lock stays valid before it is reclaimed (see lock.ts). */
  LEADERBOARD_LOCK_STALE_MS?: string;
  /** The Workflow binding — this worker's own class, used by `scheduled()` to start an instance. */
  RANK_REFRESH: { create(options?: { id?: string; params?: RankPassContinuation }): Promise<unknown> };
}

export class RankRefreshWorkflow extends WorkflowEntrypoint<RankWorkerEnv, unknown> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    // Every step below runs under `leaderboardWorkflowRetry`. Its record is empty and that is the whole
    // statement: this refresh talks to D1 and to nothing else, core answers for D1's transient
    // vocabulary, and leaderboard retries none of its own codes. See `retryPolicy.ts` — and note that
    // terminal is cheap here precisely because the lock is released in the `finally` below, so the next
    // cron fire does the whole job rather than skipping on a lock a doomed run was still holding.
    const steps = classifiedSteps(step, leaderboardWorkflowRetry, NonRetryableError);
    const config = LeaderboardConfig.parse(JSON.parse(this.env.LEADERBOARD_CONFIG));
    const db = leaderboardDatabase(this.env.DB);
    // Checked here as well as inside `acquireRefreshLock`: this is where the string an operator typed
    // becomes a number, so this is where the refusal can name the var.
    const staleMs = this.env.LEADERBOARD_LOCK_STALE_MS
      ? requireLockStaleMs(Number(this.env.LEADERBOARD_LOCK_STALE_MS))
      : undefined;

    // Mint this instance's identity and its clock ONCE, in a memoized step, and read them from the step's
    // return value. A replay does not re-run the step body, so it reuses the same holder token and the
    // same `now` — recomputing `now` could cross a window boundary mid-refresh, and a fresh token would
    // orphan the lock.
    // A run that continues a pass takes the pass's identity and clock from its params instead. A cron fire
    // carries none, and starts a pass of its own.
    const parsed = RankPassContinuation.safeParse(event.payload);
    const continuation = parsed.success ? parsed.data : undefined;
    const ctx: { holder: string; nowMs: number } = continuation
      ? { holder: continuation.holder, nowMs: continuation.nowMs }
      : await steps.do("refresh-context", async () => ({ holder: crypto.randomUUID(), nowMs: Date.now() }));
    const now = new Date(ctx.nowMs);
    // The lock is renewed at this run's own start, memoized, so a long chain of runs keeps it fresh while
    // every run still ranks against the pass's clock.
    const lockNow = continuation ? new Date(await steps.do("lock-clock", async () => Date.now())) : now;

    // Acquire and release run OUTSIDE steps, deliberately — the one place this file does side effects
    // outside a step. Both are idempotent D1 ops, and re-running them on every replay is exactly what
    // keeps the lock state honest: acquire re-validates against live D1 (an instance whose stale lock was
    // reclaimed while it was interrupted re-checks, sees the lock is no longer its own, and stands down,
    // instead of resuming on a memoized "acquired" and writing concurrently); release re-converges the
    // same way. A memoized acquire/release step would instead freeze a stale decision across the replay.
    if (!(await acquireRefreshLock(db, ctx.holder, lockNow, staleMs))) return;

    // Set once the next run of this pass exists: the lock is its now, so this run must not release it.
    let handedOff = false;
    try {
      // This run's page of instances is read once, in a step, so a replay walks the boards the first
      // attempt walked. The configured boards belong to the run that starts the pass.
      const page: { keys: string[]; next: string | null } = await steps.do("instances", async () => {
        const read = await instancePage(db, config, continuation?.after ?? null);
        return { keys: read.boards.map((board) => board.key), next: read.next };
      });
      const boards = [
        ...(continuation ? [] : config.boards),
        ...page.keys.flatMap((key) => {
          const board = resolveBoard(config, key);
          return board ? [board] : [];
        }),
      ];
      // Prune first, in its own durable step, so the refresh never ranks rows about to be deleted.
      await steps.do("prune", () => pruneBoards(this.env.DB, boards, now));

      for (const board of materializedBoards(config, boards)) {
        // The open window, every pass. A closed window's ranks were finalized while it was open — unless an
        // act or a void moved it since and marked it stale, so those are read, in a step so a replay
        // renumbers the same set, and renumbered after it.
        const open = windowKeyAt(board.window, now);
        const marked: StaleWindow[] = await steps.do(`stale:${board.key}`, () => staleWindows(db, board.key));
        const windows = [open, ...marked.map((m) => m.windowKey).filter((key) => key !== open)];
        for (const window of windows) {
          // The open window keeps the step names it always had, so an instance mid-flight across a deploy
          // resumes into the same steps.
          const name = window === open ? `refresh:${board.key}` : `refresh:${board.key}:${window}`;
          let cursor: Keyset | null = null;
          let startRank = 0;
          let batch = 0;
          // One step per batch of ~64k entries, threading the cursor. A board of any size completes across
          // however many steps it needs; each is independently retried by the Workflow runtime.
          for (;;) {
            const from: Keyset | undefined = cursor ?? undefined;
            const result: RefreshResult = await steps.do(`${name}:${batch}`, () =>
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
          const mark = marked.find((m) => m.windowKey === window);
          if (mark) await steps.do(`clear-stale:${board.key}:${window}`, () => clearStale(db, board.key, mark));
        }
      }

      const after = page.next;
      if (after !== null) {
        // More instances follow: the next run walks them. Its id is fixed by the pass and its position, so
        // the pass names each run once.
        const run = (continuation?.run ?? 0) + 1;
        await steps.do("continue", async () => {
          await this.env.RANK_REFRESH.create({
            id: `${ctx.holder}-${run}`,
            params: { holder: ctx.holder, nowMs: ctx.nowMs, after, run },
          });
        });
        handedOff = true;
      }
    } finally {
      // Release even if a step threw, so a failure does not wedge the lock until it ages out. Outside a
      // step (see the acquire note) so a replay re-releases rather than skipping a memoized release. A run
      // that handed the pass on leaves the lock to the run that now holds it.
      if (!handedOff) await releaseRefreshLock(db, ctx.holder);
    }
  }
}

export default {
  /**
   * Cron entry: start one rank-refresh Workflow instance per fire. Each fire starts a pass from the top;
   * the checkpointing is within an instance (resume on crash), not across fires (a fire is a fresh full
   * refresh), and a pass longer than one page of instances continues in runs of its own. If a fire lands while a previous refresh is still running, the new instance takes no lock
   * and exits immediately, so overlapping instances never write concurrently — see the lock acquisition
   * in `run()` above.
   */
  async scheduled(_controller: unknown, env: RankWorkerEnv): Promise<void> {
    await env.RANK_REFRESH.create();
  },
};
