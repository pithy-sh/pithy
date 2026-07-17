import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { type LeaderboardBoard, LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { windowKeyAt } from "../window/schedule";
import { RANK_CHUNK_SIZE } from "./materialize";
import { runRankPass } from "./worker";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const DAILY = "0 0 * * *";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: { "0001_entries": leaderboard_0001_entries },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const config = (input: LeaderboardConfigInput) => LeaderboardConfig.parse(input);

/** The nth configured board. Throws rather than asserting non-null, so a bad index fails as a test bug. */
function boardAt(c: LeaderboardConfig, index: number): LeaderboardBoard {
  const found = c.boards[index];
  if (!found) throw new Error(`test config has no board at index ${index}`);
  return found;
}

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

describe("runRankPass", () => {
  test("prunes closed windows past retain, even when rank is live", async () => {
    // Retention is why a live board set with windows still deploys this worker.
    const c = config({ boards: [{ key: "b1", direction: "desc", window: DAILY, retain: 1 }] });
    const store = entryStore(leaderboardDatabase(env.DB));
    const b = boardAt(c, 0);
    for (let i = 0; i < 5; i++) {
      const day = new Date(NOW.getTime() - i * 86_400_000);
      await store.submit(b, windowKeyAt(DAILY, day), "u1", 10, day, true);
    }
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.pruned).toBe(3);
    expect(result.refreshed).toEqual([]);
  });

  test("refreshes the open window's ranks when the board is materialized", async () => {
    const c = config({ boards: [{ key: "b1", direction: "desc" }], rank: { materialize: "0 * * * *" } });
    const store = entryStore(leaderboardDatabase(env.DB));
    for (let i = 0; i < 5; i++) await store.submit(boardAt(c, 0), "all", `u${i}`, 100 - i, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed).toEqual([
      { board: "b1", window: "all", ranked: 5, chunks: 1, complete: true, cursor: null },
    ]);
    const { results } = await env.DB.prepare(
      "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE user_id = 'u0'",
    ).all<{ rank: number }>();
    expect(results[0]?.rank).toBe(1);
  });

  test("refreshes only the open window, since a closed window's ranks stopped moving", async () => {
    const c = config({
      boards: [{ key: "b1", direction: "desc", window: DAILY, retain: 5 }],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    const closed = windowKeyAt(DAILY, new Date(NOW.getTime() - 86_400_000));
    await store.submit(boardAt(c, 0), closed, "u1", 10, NOW, true);
    await store.submit(boardAt(c, 0), windowKeyAt(DAILY, NOW), "u2", 10, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed.map((r) => r.window)).toEqual([windowKeyAt(DAILY, NOW)]);
  });

  test("refreshes every board", async () => {
    const c = config({
      boards: [
        { key: "b1", direction: "desc" },
        { key: "b2", direction: "asc" },
      ],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    await store.submit(boardAt(c, 0), "all", "u1", 10, NOW, true);
    await store.submit(boardAt(c, 1), "all", "u1", 10, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed.map((r) => r.board)).toEqual(["b1", "b2"]);
  });

  test("ranks every board to completion across many chunks — no per-invocation ceiling", async () => {
    // The old design capped a run and left the tail stale; runRankPass now completes each board fully.
    const c = config({
      boards: [
        { key: "b1", direction: "desc" },
        { key: "b2", direction: "desc" },
      ],
      rank: { materialize: "0 * * * *" },
    });
    const store = entryStore(leaderboardDatabase(env.DB));
    const big = RANK_CHUNK_SIZE * 3 + 5;
    for (let i = 0; i < big; i++)
      await store.submit(boardAt(c, 0), "all", `u${String(i).padStart(4, "0")}`, i, NOW, true);
    await store.submit(boardAt(c, 1), "all", "v1", 1, NOW, true);
    const result = await runRankPass(env.DB, c, NOW);
    expect(result.refreshed.map((r) => [r.board, r.ranked, r.complete])).toEqual([
      ["b1", big, true],
      ["b2", 1, true],
    ]);
    // The tail of the big board actually got a rank — it is not stale. `u0000` has the lowest score
    // (0), so on a desc board it sits in last place, rank `big`. If the pass had a ceiling, it would be
    // null.
    const { results } = await env.DB.prepare(
      "SELECT rank FROM pithy_leaderboard_entries WHERE board_id='b1' AND user_id='u0000'",
    ).all<{ rank: number }>();
    expect(results[0]?.rank).toBe(big);
  });

  test("does nothing on an all-time live board set — the case that needs no worker at all", async () => {
    const c = config({ boards: [{ key: "b1", direction: "desc" }] });
    await entryStore(leaderboardDatabase(env.DB)).submit(boardAt(c, 0), "all", "u1", 10, NOW, true);
    expect(await runRankPass(env.DB, c, NOW)).toEqual({ pruned: 0, refreshed: [] });
  });
});
