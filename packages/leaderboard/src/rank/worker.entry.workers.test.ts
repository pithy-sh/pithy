// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, introspectWorkflowInstance } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { createGate } from "@pithy-sh/core/src/testing";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { assertBoardDefinition } from "../board/registry";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardConfig, type LeaderboardConfigInput, resolveBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { type HeldRankRun, rankRuns, TEST_INSTANCE_PAGE_SIZE } from "./rankWorker.fixture.test";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const HOLDER = "pass-holder";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: LEADERBOARD_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** Who holds the rank refresh lock right now, or null when nobody does. */
async function lockHolder(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT holder FROM pithy_leaderboard_locks WHERE name = 'rank-refresh'").first<{
    holder: string;
  }>();
  return row?.holder ?? null;
}

/** Each player's rank on one board's all-time window, best first. */
async function ranksOf(board: string): Promise<{ user_id: string; rank: number | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE board_id = ? AND window_key = 'all' ORDER BY user_id",
  )
    .bind(board)
    .all<{ user_id: string; rank: number | null }>();
  return results;
}

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_stale_windows",
    "pithy_leaderboard_moderations",
    "pithy_leaderboard_contributions",
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  rankRuns.holds = new Map();
  rankRuns.payloads.length = 0;
});

/** Seeds one configured board and a family whose five instances span three runs, and returns the instance keys. */
async function seedPass(): Promise<string[]> {
  const input: LeaderboardConfigInput = {
    boards: [{ key: "b1", direction: "desc" }],
    families: [{ pattern: "level/:levelId", direction: "desc" }],
    rank: { materialize: "0 * * * *" },
  };
  rankRuns.config = JSON.stringify(input);
  const config = LeaderboardConfig.parse(input);
  const db = leaderboardDatabase(env.DB);
  const store = entryStore(db);
  const b1 = config.boards[0];
  if (!b1) throw new Error("expected b1 to be configured");
  await store.submit(b1, "all", "u1", 10, NOW, true);
  await store.submit(b1, "all", "u2", 20, NOW, true);
  const keys = ["level/a", "level/b", "level/c", "level/d", "level/e"];
  for (const key of keys) {
    const instance = resolveBoard(config, key);
    if (!instance) throw new Error(`expected ${key} to resolve`);
    await assertBoardDefinition(db, instance, NOW);
    await store.submit(instance, "all", "u1", 10, NOW, true);
    await store.submit(instance, "all", "u2", 20, NOW, true);
  }
  expect(TEST_INSTANCE_PAGE_SIZE).toBeLessThan(keys.length);
  return keys;
}

describe("RankRefreshWorkflow", () => {
  test("a continue step that finds its next run already created counts as handed off and keeps the lock", async () => {
    const keys = await seedPass();
    const held: HeldRankRun = {
      arrived: createGate({ name: "run 1 arrived" }),
      release: createGate({ name: "run 1 released" }),
    };
    const last: HeldRankRun = {
      arrived: createGate({ name: "run 2 arrived" }),
      release: createGate({ name: "run 2 released" }),
    };
    last.release.open();
    rankRuns.holds = new Map([
      [1, held],
      [2, last],
    ]);

    await using first = await introspectWorkflowInstance(env.RANK_REFRESH, "cron-fire");
    await first.modify(async (m) => {
      await m.mockStepResult({ name: "refresh-context" }, { holder: HOLDER, nowMs: NOW.getTime() });
    });
    await using second = await introspectWorkflowInstance(env.RANK_REFRESH, `${HOLDER}-1`);
    await using third = await introspectWorkflowInstance(env.RANK_REFRESH, `${HOLDER}-2`);
    try {
      // The next run exists before the first run's `continue` step runs its body, which is where a replay of
      // that step stands: the create it repeats was already accepted, and the binding refuses the id.
      const params = { holder: HOLDER, nowMs: NOW.getTime(), after: "level/b", run: 1 };
      await env.RANK_REFRESH.create({ id: `${HOLDER}-1`, params });
      await held.arrived.opened();
      await expect(env.RANK_REFRESH.create({ id: `${HOLDER}-1`, params })).rejects.toThrow(/already_exists/);

      await env.RANK_REFRESH.create({ id: "cron-fire" });
      await first.waitForStatus("complete");
      expect(await lockHolder()).toBe(HOLDER);

      held.release.open();
      await second.waitForStatus("complete");
      await third.waitForStatus("complete");
      expect(await lockHolder()).toBeNull();
      for (const board of ["b1", ...keys]) {
        expect(await ranksOf(board)).toEqual([
          { user_id: "u1", rank: 2 },
          { user_id: "u2", rank: 1 },
        ]);
      }
    } finally {
      held.release.open();
    }
  });

  test("hands a pass over more instances than one page to continuation runs, holding the lock until the last", async () => {
    const keys = await seedPass();

    const hold = (run: number): HeldRankRun => ({
      arrived: createGate({ name: `run ${run} arrived` }),
      release: createGate({ name: `run ${run} released` }),
    });
    const holds = new Map([
      [1, hold(1)],
      [2, hold(2)],
    ]);
    rankRuns.holds = holds;
    const arrived = async (run: number) => holds.get(run)?.arrived.opened();
    const open = (run: number) => holds.get(run)?.release.open();

    await using first = await introspectWorkflowInstance(env.RANK_REFRESH, "cron-fire");
    await first.modify(async (m) => {
      await m.mockStepResult({ name: "refresh-context" }, { holder: HOLDER, nowMs: NOW.getTime() });
    });
    await using second = await introspectWorkflowInstance(env.RANK_REFRESH, `${HOLDER}-1`);
    await using third = await introspectWorkflowInstance(env.RANK_REFRESH, `${HOLDER}-2`);
    try {
      await env.RANK_REFRESH.create({ id: "cron-fire" });

      await first.waitForStatus("complete");
      expect(await first.waitForStepResult({ name: "instances" })).toEqual({
        keys: ["level/a", "level/b"],
        next: "level/b",
      });
      // The first run has finished and the next is held before it starts: the lock is the pass's, still.
      await arrived(1);
      expect(await lockHolder()).toBe(HOLDER);
      expect(rankRuns.payloads.at(-1)).toEqual({ holder: HOLDER, nowMs: NOW.getTime(), after: "level/b", run: 1 });

      open(1);
      await second.waitForStatus("complete");
      expect(await second.waitForStepResult({ name: "instances" })).toEqual({
        keys: ["level/c", "level/d"],
        next: "level/d",
      });
      await arrived(2);
      expect(await lockHolder()).toBe(HOLDER);
      expect(rankRuns.payloads.at(-1)).toEqual({ holder: HOLDER, nowMs: NOW.getTime(), after: "level/d", run: 2 });

      open(2);
      await third.waitForStatus("complete");
      expect(await third.waitForStepResult({ name: "instances" })).toEqual({ keys: ["level/e"], next: null });
      expect(await lockHolder()).toBeNull();
      expect(rankRuns.payloads).toHaveLength(3);

      // Each board is refreshed by exactly the run whose page holds it, and the configured board by the first.
      const ranked = { complete: true, ranked: 2 };
      expect(await first.waitForStepResult({ name: "refresh:b1:0" })).toMatchObject(ranked);
      for (const [run, boards] of [
        [first, ["level/a", "level/b"]],
        [second, ["level/c", "level/d"]],
        [third, ["level/e"]],
      ] as const) {
        for (const board of boards) {
          expect(await run.waitForStepResult({ name: `refresh:${board}:0` })).toMatchObject(ranked);
        }
      }
      for (const board of ["b1", ...keys]) {
        expect(await ranksOf(board)).toEqual([
          { user_id: "u1", rank: 2 },
          { user_id: "u2", rank: 1 },
        ]);
      }
    } finally {
      open(1);
      open(2);
    }
  });
});
