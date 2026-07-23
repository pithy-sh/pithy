import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { LeaderboardBoard } from "@pithy-sh/leaderboard/src/config/config";
import { leaderboardDatabase } from "@pithy-sh/leaderboard/src/data/tables";
import { entryStore } from "@pithy-sh/leaderboard/src/entry/store";
import { leaderboard_0001_entries } from "@pithy-sh/leaderboard/src/migrations/0001_entries";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import type { MultiplayerLeaderboard } from "../config/config";
import { publishResultToLeaderboard } from "./leaderboard";

const AT = new Date(1_700_000_000_000);

beforeEach(async () => {
  for (const t of ["pithy_leaderboard_entries", "pithy_leaderboard_boards", "pithy_leaderboard_locks"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await leaderboard_0001_entries.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
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
    await publishResultToLeaderboard(env.DB, config, {
      members: ["alice", "bob"],
      winnerUserId: "alice",
      draw: false,
      at: AT,
    });
    expect(await readScore("alice")).toBe(3);
    expect(await readScore("bob")).toBe(0);
  });

  test("awards both players draw points on a draw", async () => {
    await publishResultToLeaderboard(env.DB, config, {
      members: ["alice", "bob"],
      winnerUserId: null,
      draw: true,
      at: AT,
    });
    expect(await readScore("alice")).toBe(1);
    expect(await readScore("bob")).toBe(1);
  });

  test("a sum board accumulates points across sessions", async () => {
    await publishResultToLeaderboard(env.DB, config, {
      members: ["alice", "bob"],
      winnerUserId: "alice",
      draw: false,
      at: AT,
    });
    await publishResultToLeaderboard(env.DB, config, {
      members: ["alice", "bob"],
      winnerUserId: "alice",
      draw: false,
      at: AT,
    });
    expect(await readScore("alice")).toBe(6);
    expect(await readScore("bob")).toBe(0);
  });

  test("the published entry is a real leaderboard entry the board ranks", async () => {
    await publishResultToLeaderboard(env.DB, config, {
      members: ["alice", "bob"],
      winnerUserId: "alice",
      draw: false,
      at: AT,
    });
    const entry = await entryStore(leaderboardDatabase(env.DB)).get(board.key, "all", "alice");
    expect(entry?.userId).toBe("alice");
    expect(entry?.visible).toBe(true);
  });
});
