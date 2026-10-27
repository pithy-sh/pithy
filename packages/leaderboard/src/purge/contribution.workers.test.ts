// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { leaderboard } from "../capability";
import { LeaderboardConfig } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { runRankPass } from "../rank/worker";
import { windowKeyAt } from "../window/schedule";
import { LEADERBOARD_PURGE_SUMMARY, leaderboardUserPurge } from "./contribution";

/**
 * Leaderboard's part of a person's purge and export (#814), over real D1: rows present, exported, purged,
 * gone — and nobody else's touched. Over every table that names a player: the entries, what each result put on
 * them, and their moderation history.
 */

const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });
/** The contribution's export, which every kit contribution declares. */
async function exportOf(input: ReturnType<typeof context>): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const purge = leaderboardUserPurge();

async function count(table: string, column: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const table of ["entries", "boards", "locks", "contributions", "moderations", "stale_windows"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS pithy_leaderboard_${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of Object.values(LEADERBOARD_MIGRATIONS)) await migration.up(db);
  await env.DB.exec(
    "INSERT INTO pithy_leaderboard_entries (board_id, window_key, user_id, score, achieved_at, submitted_at) VALUES ('weekly', '2026-W43', 'ada', 120, 1700000000000, 1700000000000), ('alltime', 'all', 'ada', 900, 1700000000000, 1700000000000), ('weekly', '2026-W43', 'bob', 80, 1700000000000, 1700000000000)",
  );
  await env.DB.exec(
    "INSERT INTO pithy_leaderboard_contributions (result_id, board_id, window_key, user_id, score, aggregation, created_at) VALUES ('session-1', 'weekly', '2026-W43', 'ada', 70, 'sum', 1700000000000), ('session-1', 'weekly', '2026-W43', 'bob', 30, 'sum', 1700000000000)",
  );
  const state = (score: number, hidden: boolean) =>
    JSON.stringify({ kind: "entry", score, visible: true, hidden }).replaceAll("'", "''");
  await env.DB.exec(
    `INSERT INTO pithy_leaderboard_moderations (idempotency_key, act, board_id, window_key, user_id, reason, before, after, changed, connection_id, actor_id, created_at) VALUES ('key-ada', 'hide', 'weekly', '2026-W43', 'ada', 'Reported for cheating.', '${state(120, false)}', '${state(120, true)}', 1, 'conn-1', 'operator-1', 1700000000000), ('key-bob', 'correct', 'weekly', '2026-W43', 'bob', 'Score typo.', '${state(800, false)}', '${state(80, false)}', 1, 'conn-1', 'operator-1', 1700000000000)`,
  );
});

describe("the leaderboard user purge", () => {
  test("leaderboard() declares it for the user subject, with a summary and an export", () => {
    const declared = leaderboard({ boards: [{ key: "weekly", direction: "desc" }] }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(LEADERBOARD_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the person's rows, and no credential", async () => {
    const data = await exportOf(context("ada"));
    expect(data.entries).toEqual([
      expect.objectContaining({ boardId: "weekly", userId: "ada", score: 120, visible: true, hidden: false }),
      expect.objectContaining({ boardId: "alltime", userId: "ada", score: 900 }),
    ]);
    expect(data.contributions).toEqual([
      expect.objectContaining({ resultId: "session-1", boardId: "weekly", userId: "ada", score: 70 }),
    ]);
    expect(data.moderations).toEqual([
      expect.objectContaining({
        act: "hide",
        userId: "ada",
        reason: "Reported for cheating.",
        before: { kind: "entry", score: 120, visible: true, hidden: false },
        after: { kind: "entry", score: 120, visible: true, hidden: true },
      }),
    ]);
    expect(credentialFields(data)).toEqual([]);
  });

  test("leaves out of a moderation what is the operator's, not the person's", async () => {
    const [moderation] = (await exportOf(context("ada"))).moderations as Record<string, unknown>[];
    expect(moderation).not.toHaveProperty("idempotencyKey");
    expect(moderation).not.toHaveProperty("connectionId");
    expect(moderation).not.toHaveProperty("actorId");
  });

  test("erases them, and leaves everyone else's", async () => {
    await purge.erase(context("ada"));
    expect(await count("pithy_leaderboard_entries", "user_id", "ada")).toBe(0);
    expect(await count("pithy_leaderboard_contributions", "user_id", "ada")).toBe(0);
    expect(await count("pithy_leaderboard_moderations", "user_id", "ada")).toBe(0);
    expect(await exportOf(context("ada"))).toEqual({ entries: [], contributions: [], moderations: [] });
    expect(await count("pithy_leaderboard_contributions", "user_id", "bob")).toBe(1);
    expect(await count("pithy_leaderboard_moderations", "user_id", "bob")).toBe(1);
    expect(JSON.stringify(await exportOf(context("bob")))).toContain("bob");
    // None of Ada's entries held a stored rank, so no window has one to renumber.
    const stale = await env.DB.prepare("SELECT count(*) AS n FROM pithy_leaderboard_stale_windows").first<{
      n: number;
    }>();
    expect(stale?.n).toBe(0);
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });

  describe("a ranked entry in a closed window", () => {
    // A closed window is renumbered only when something marks it stale, so a purge that deletes a ranked entry
    // there and marks nothing leaves the window's stored ranks with a hole in them for good.
    const DAILY = "0 0 * * *";
    const NOW = new Date("2026-07-16T12:00:00.000Z");
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const closed = windowKeyAt(DAILY, yesterday);
    const c = LeaderboardConfig.parse({
      boards: [{ key: "daily", direction: "desc", window: DAILY, retain: 5 }],
      rank: { materialize: "0 * * * *" },
    });
    const ranks = async () => {
      const { results } = await env.DB.prepare(
        "SELECT user_id, rank FROM pithy_leaderboard_entries WHERE board_id = 'daily' AND window_key = ? ORDER BY user_id",
      )
        .bind(closed)
        .all<{ user_id: string; rank: number | null }>();
      return Object.fromEntries(results.map((row) => [row.user_id, row.rank]));
    };

    beforeEach(async () => {
      const board = c.boards[0];
      if (!board) throw new Error("test config has no board");
      const store = entryStore(leaderboardDatabase(env.DB));
      for (const [userId, score] of [
        ["ada", 100],
        ["bob", 90],
        ["cy", 80],
      ] as const) {
        await store.submit(board, closed, userId, score, yesterday, true);
      }
      // The pass that ran while the window was open left it ranked.
      await runRankPass(env.DB, c, yesterday);
      expect(await ranks()).toEqual({ ada: 1, bob: 2, cy: 3 });
    });

    test("is renumbered from 1 on the next pass once the person holding #1 is purged", async () => {
      await purge.erase(context("ada"));
      const result = await runRankPass(env.DB, c, NOW);
      expect(await ranks()).toEqual({ bob: 1, cy: 2 });
      expect(result.refreshed.map((r) => r.window)).toContain(closed);
    });
  });
});
