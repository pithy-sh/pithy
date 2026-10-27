// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { LEADERBOARD_MIGRATION_ORDER } from "@pithy-sh/leaderboard/src/capability";
import { LeaderboardBoard } from "@pithy-sh/leaderboard/src/config/config";
import { leaderboardDatabase } from "@pithy-sh/leaderboard/src/data/tables";
import { entryStore } from "@pithy-sh/leaderboard/src/entry/store";
import { LEADERBOARD_MIGRATIONS } from "@pithy-sh/leaderboard/src/migrations/all";
import { leaderboardPeer } from "@pithy-sh/leaderboard/src/peer";
import { beforeEach, describe, expect, test } from "vitest";
import type { MultiplayerLeaderboard } from "../config/config";
import { publishResultToLeaderboard } from "./leaderboard";

const AT = new Date(1_700_000_000_000);

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
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: LEADERBOARD_MIGRATIONS,
    },
  ]);
  if (!registry.app) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, registry.app);
});

// A points board: sum/desc, so wins accumulate across sessions.
const config: MultiplayerLeaderboard = {
  board: "wins",
  direction: "desc",
  aggregation: "sum",
  points: { win: 3, draw: 1, loss: 0 },
};

const board = LeaderboardBoard.parse({ key: "wins", direction: "desc", aggregation: "sum" });
const readScore = async (userId: string): Promise<number | undefined> =>
  (await entryStore(leaderboardDatabase(env.DB)).get("wins", "all", userId))?.score;

describe("publishResultToLeaderboard", () => {
  test("awards the winner win points and the loser loss points", async () => {
    await publishResultToLeaderboard(
      env.DB,
      config,
      {
        members: ["alice", "bob"],
        winnerUserId: "alice",
        draw: false,
        at: AT,
        resultId: "session-1",
      },
      leaderboardPeer,
    );
    expect(await readScore("alice")).toBe(3);
    expect(await readScore("bob")).toBe(0);
  });

  test("awards both players draw points on a draw", async () => {
    await publishResultToLeaderboard(
      env.DB,
      config,
      {
        members: ["alice", "bob"],
        winnerUserId: null,
        draw: true,
        at: AT,
        resultId: "session-2",
      },
      leaderboardPeer,
    );
    expect(await readScore("alice")).toBe(1);
    expect(await readScore("bob")).toBe(1);
  });

  test("a sum board accumulates points across sessions", async () => {
    await publishResultToLeaderboard(
      env.DB,
      config,
      {
        members: ["alice", "bob"],
        winnerUserId: "alice",
        draw: false,
        at: AT,
        resultId: "session-3",
      },
      leaderboardPeer,
    );
    await publishResultToLeaderboard(
      env.DB,
      config,
      {
        members: ["alice", "bob"],
        winnerUserId: "alice",
        draw: false,
        at: AT,
        resultId: "session-4",
      },
      leaderboardPeer,
    );
    expect(await readScore("alice")).toBe(6);
    expect(await readScore("bob")).toBe(0);
  });

  test("the published entry is a real leaderboard entry the board ranks", async () => {
    await publishResultToLeaderboard(
      env.DB,
      config,
      {
        members: ["alice", "bob"],
        winnerUserId: "alice",
        draw: false,
        at: AT,
        resultId: "session-5",
      },
      leaderboardPeer,
    );
    const entry = await entryStore(leaderboardDatabase(env.DB)).get(board.key, "all", "alice");
    expect(entry?.userId).toBe("alice");
    expect(entry?.visible).toBe(true);
  });

  test("records the session on every entry it writes, so a void can find them", async () => {
    await publishResultToLeaderboard(
      env.DB,
      config,
      { members: ["alice", "bob"], winnerUserId: "alice", draw: false, at: AT, resultId: "session-9" },
      leaderboardPeer,
    );
    const store = entryStore(leaderboardDatabase(env.DB));
    expect((await store.get("wins", "all", "alice"))?.resultId).toBe("session-9");
    expect((await store.get("wins", "all", "bob"))?.resultId).toBe("session-9");

    const report = await leaderboardPeer.voidResult(env.DB, "session-9");
    expect(report.removed.map((entry) => entry.userId)).toEqual(["alice", "bob"]);
    expect(await readScore("alice")).toBeUndefined();
  });

  test("a retried publish of one session folds its points once", async () => {
    const input = { members: ["alice", "bob"], winnerUserId: "alice", draw: false, at: AT, resultId: "session-9" };
    await publishResultToLeaderboard(env.DB, config, input, leaderboardPeer);
    await publishResultToLeaderboard(env.DB, config, input, leaderboardPeer);
    expect(await readScore("alice")).toBe(3);
  });

  test("a leaderboard that predates result ids still gets the plain submission", async () => {
    const { submitResult: _absent, voidResult: _alsoAbsent, ...older } = leaderboardPeer;
    await publishResultToLeaderboard(
      env.DB,
      config,
      { members: ["alice", "bob"], winnerUserId: "alice", draw: false, at: AT, resultId: "session-9" },
      older as typeof leaderboardPeer,
    );
    const entry = await entryStore(leaderboardDatabase(env.DB)).get("wins", "all", "alice");
    expect(entry?.score).toBe(3);
    expect(entry?.resultId).toBeNull();
  });

  test("with no leaderboard composed, it refuses and writes nothing", async () => {
    // The session catches this and logs it (#645): a result must not fail over a board nobody composed, and
    // it must not vanish without a trace either.
    await expect(
      publishResultToLeaderboard(
        env.DB,
        config,
        { members: ["alice", "bob"], winnerUserId: "alice", draw: false, at: AT, resultId: "session-x" },
        undefined,
      ),
    ).rejects.toThrow("This game publishes to a leaderboard, and no leaderboard is composed.");
    expect(await readScore("alice")).toBeUndefined();
  });
});
