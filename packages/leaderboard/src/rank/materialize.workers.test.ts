// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { REFRESH_ROWS_WRITTEN_PER_ENTRY } from "../../scripts/costModel";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import type { LeaderboardBoard } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { type Keyset, MAX_BOUND_PARAMETERS, RANK_CHUNK_SIZE, refreshWindowRanks } from "./materialize";
import { rankOf, topEntries } from "./query";

const WINDOW = "all";
const T0 = new Date(1_700_000_000_000);

const board = (overrides: Partial<LeaderboardBoard> = {}): LeaderboardBoard =>
  ({ key: "b1", direction: "desc", aggregation: "best", retain: 12, ...overrides }) as LeaderboardBoard;

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

const db = () => leaderboardDatabase(env.DB);

async function seed(count: number, b = board()): Promise<void> {
  const store = entryStore(db());
  for (let i = 0; i < count; i++) {
    await store.submit(b, WINDOW, `u${String(i).padStart(4, "0")}`, count - i, new Date(T0.getTime() + i), true);
  }
}

async function storedRanks(): Promise<Array<[string, number | null]>> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE board_id='b1' ORDER BY rank",
  ).all<{ user_id: string; rank: number | null }>();
  return results.map((row) => [row.user_id, row.rank]);
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

describe("chunk sizing", () => {
  test("stays under D1's bound-parameter cap: three per row plus the board and window", () => {
    expect(RANK_CHUNK_SIZE * 3 + 2).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });
});

describe("refresh write cost", () => {
  test("a rank-only update writes fewer rows than a submission — the rank column is unindexed", async () => {
    // The cost model prices refresh writes separately from submission writes, because a refresh touches
    // only the `rank` column, which no index covers. This measures the real per-entry refresh cost so
    // the model's REFRESH_ROWS_WRITTEN_PER_ENTRY constant stays honest.
    await seed(1);
    const { results } = await env.DB.prepare("SELECT id FROM pithy_leaderboard_entries LIMIT 1").all<{ id: number }>();
    const id = results[0]?.id ?? 0;
    const single = await env.DB.prepare("UPDATE pithy_leaderboard_entries SET rank = 5 WHERE id = ?").bind(id).run();
    console.log(`MEASURED rank-only update: rows_written=${single.meta.rows_written}`);
    expect(single.meta.rows_written).toBe(REFRESH_ROWS_WRITTEN_PER_ENTRY);
  });
});

describe("refreshWindowRanks", () => {
  test("writes ranks that match what a live count would return", async () => {
    await seed(10);
    await refreshWindowRanks(db(), board(), WINDOW);
    for (const entry of await topEntries(db(), board(), WINDOW, 10)) {
      expect((await rankOf(db(), board(), WINDOW, entry.userId, true))?.rank).toBe(entry.rank);
    }
  });

  test("ranks a board larger than one chunk, so the keyset resume actually works", async () => {
    const count = RANK_CHUNK_SIZE * 3 + 5;
    await seed(count);
    const result = await refreshWindowRanks(db(), board(), WINDOW);
    expect(result.ranked).toBe(count);
    expect(result.complete).toBe(true);
    const ranks = await storedRanks();
    expect(ranks.length).toBe(count);
    expect(ranks[0]?.[1]).toBe(1);
    expect(ranks[count - 1]?.[1]).toBe(count);
  });

  test("assigns every rank exactly once across chunk boundaries", async () => {
    const count = RANK_CHUNK_SIZE * 2 + 7;
    await seed(count);
    await refreshWindowRanks(db(), board(), WINDOW);
    const ranks = (await storedRanks()).map(([, rank]) => rank);
    expect(new Set(ranks).size).toBe(count);
    expect(ranks).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  test("resumes correctly when a whole chunk shares one score, the case a keyset walk can skip", async () => {
    // Every entry ties on score, so the resume must fall through to achievedAt and userId. A keyset
    // that only compared score would loop forever or skip the rest of the board.
    const store = entryStore(db());
    const count = RANK_CHUNK_SIZE * 2;
    for (let i = 0; i < count; i++) {
      await store.submit(board(), WINDOW, `u${String(i).padStart(4, "0")}`, 50, new Date(T0.getTime() + i), true);
    }
    const result = await refreshWindowRanks(db(), board(), WINDOW);
    expect(result.ranked).toBe(count);
    const ranks = (await storedRanks()).map(([, rank]) => rank);
    expect(ranks).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  test("ranks an asc board from the lowest score", async () => {
    const asc = board({ direction: "asc" });
    await seed(5, asc);
    await refreshWindowRanks(db(), asc, WINDOW);
    const top = await topEntries(db(), asc, WINDOW, 1);
    expect((await rankOf(db(), asc, WINDOW, top[0]?.userId ?? "", true))?.rank).toBe(1);
  });

  test("stops at the chunk budget and reports the pass incomplete, with a resume cursor", async () => {
    await seed(RANK_CHUNK_SIZE * 3);
    const result = await refreshWindowRanks(db(), board(), WINDOW, { maxChunks: 1 });
    expect(result.chunks).toBe(1);
    expect(result.ranked).toBe(RANK_CHUNK_SIZE);
    expect(result.complete).toBe(false);
    expect(result.cursor).not.toBeNull();
  });

  test("resumes from the cursor to produce the same ranks as one uncapped pass", async () => {
    // This is the Workflow's core guarantee: a board ranked across many bounded, checkpointed batches
    // is identical to a board ranked in one go. No per-invocation ceiling, no gaps at batch seams.
    const count = RANK_CHUNK_SIZE * 3 + 5;
    await seed(count);

    // Batched: two chunks per step, threading the cursor and the running rank, until complete.
    let cursor: Keyset | undefined;
    let startRank = 0;
    let batches = 0;
    for (;;) {
      const r = await refreshWindowRanks(db(), board(), WINDOW, { maxChunks: 2, resumeAfter: cursor, startRank });
      batches += 1;
      if (r.complete) break;
      cursor = r.cursor ?? undefined;
      startRank = r.ranked;
      if (!cursor) break;
    }
    expect(batches).toBeGreaterThan(1); // actually took several steps
    const batched = (await storedRanks()).map(([, rank]) => rank);
    expect(batched).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  test("leaves the top of the board correct when the budget cuts the pass short", async () => {
    // A partial pass is not a broken pass: ranks are positions in a total ordering, so the prefix it
    // finished is exactly right, and the tail nobody is looking at is what goes stale.
    await seed(RANK_CHUNK_SIZE * 3);
    await refreshWindowRanks(db(), board(), WINDOW, { maxChunks: 1 });
    const assigned = (await storedRanks()).map(([, rank]) => rank).filter((rank) => rank !== null);
    expect(assigned).toEqual(Array.from({ length: RANK_CHUNK_SIZE }, (_, i) => i + 1));
  });

  test("does not rank entries the player opted out of", async () => {
    await seed(5);
    await entryStore(db()).setVisibility("b1", WINDOW, "u0000", false);
    await refreshWindowRanks(db(), board(), WINDOW);
    const { results } = await env.DB.prepare("SELECT rank FROM pithy_leaderboard_entries WHERE user_id = 'u0000'").all<{
      rank: number | null;
    }>();
    expect(results[0]?.rank).toBeNull();
  });

  test("does not rank hidden entries", async () => {
    await seed(5);
    await entryStore(db()).hide("b1", WINDOW, "u0000", true);
    await refreshWindowRanks(db(), board(), WINDOW);
    const { results } = await env.DB.prepare("SELECT rank FROM pithy_leaderboard_entries WHERE user_id = 'u0000'").all<{
      rank: number | null;
    }>();
    expect(results[0]?.rank).toBeNull();
  });

  test("closes the gap a hidden entry leaves rather than skipping a rank number", async () => {
    await seed(5);
    await entryStore(db()).hide("b1", WINDOW, "u0000", true);
    await refreshWindowRanks(db(), board(), WINDOW);
    expect((await storedRanks()).filter(([, rank]) => rank !== null).map(([, rank]) => rank)).toEqual([1, 2, 3, 4]);
  });

  test("is idempotent — a second pass changes nothing", async () => {
    await seed(RANK_CHUNK_SIZE + 3);
    await refreshWindowRanks(db(), board(), WINDOW);
    const first = await storedRanks();
    await refreshWindowRanks(db(), board(), WINDOW);
    expect(await storedRanks()).toEqual(first);
  });

  test("reports an empty board complete without writing anything", async () => {
    expect(await refreshWindowRanks(db(), board(), WINDOW)).toEqual({
      ranked: 0,
      chunks: 0,
      complete: true,
      cursor: null,
    });
  });

  test("never touches another board's ranks", async () => {
    await seed(3);
    await seed(3, board({ key: "b2" }));
    await refreshWindowRanks(db(), board({ key: "b2" }), WINDOW);
    expect((await storedRanks()).every(([, rank]) => rank === null)).toBe(true);
  });
});
