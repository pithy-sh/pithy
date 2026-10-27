// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { moderateEntry } from "../admin/moderate";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardBoard } from "../config/config";
import { LEADERBOARD_CONTRIBUTIONS_TABLE, LEADERBOARD_STALE_WINDOWS_TABLE, leaderboardDatabase } from "../data/tables";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { submitResult, voidResult } from "./result";
import { deleteEntry, entryStore } from "./store";

/**
 * Provenance for a void (#817): a result-sourced submission records which result wrote it, and a void takes
 * back exactly what that result put on the board.
 */

const T0 = new Date(1_700_000_000_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

const sumBoard = LeaderboardBoard.parse({ key: "points", direction: "desc", aggregation: "sum" });
const bestBoard = LeaderboardBoard.parse({ key: "best", direction: "desc" });
const latestBoard = LeaderboardBoard.parse({ key: "latest", direction: "desc", aggregation: "latest" });

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

const db = () => leaderboardDatabase(env.DB);
const store = () => entryStore(db());

/** Submit `score` for `userId` on `board` as result `resultId`. */
const publish = (board: LeaderboardBoard, resultId: string, userId: string, score: number, when = T0) =>
  submitResult(env.DB, { board, windowKey: "all", userId, score, at: when, visibleByDefault: true, resultId });

async function contributions(): Promise<{ resultId: string; userId: string; score: number }[]> {
  return db()
    .selectFrom(LEADERBOARD_CONTRIBUTIONS_TABLE)
    .select(["resultId", "userId", "score"])
    .orderBy("id")
    .execute();
}

/** Correct `userId`'s entry on `board` to `score`, as an operator would. */
const correct = (board: LeaderboardBoard, userId: string, score: number) =>
  moderateEntry(env.DB, {
    act: "correct",
    board,
    windowKey: "all",
    userId,
    score,
    idempotencyKey: `correct-${board.key}-${userId}`,
    reason: "Clock exploit.",
    actor: { connectionId: "c1", actorId: "operator-1" },
    materialized: false,
    now: at(5000),
  });

async function staleWindows(): Promise<{ boardId: string; windowKey: string }[]> {
  return db().selectFrom(LEADERBOARD_STALE_WINDOWS_TABLE).select(["boardId", "windowKey"]).execute();
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
});

describe("submitResult", () => {
  test("records the result on the entry and as a contribution", async () => {
    expect(await publish(sumBoard, "s1", "u1", 3)).toEqual({ recorded: true });
    expect((await store().get("points", "all", "u1"))?.resultId).toBe("s1");
    expect(await contributions()).toEqual([{ resultId: "s1", userId: "u1", score: 3 }]);
  });

  test("a retried publish folds nothing twice", async () => {
    // The bug a contribution row closes: a publish retried after a timeout used to add the points again.
    await publish(sumBoard, "s1", "u1", 3);
    expect(await publish(sumBoard, "s1", "u1", 3, at(1000))).toEqual({ recorded: false });
    expect((await store().get("points", "all", "u1"))?.score).toBe(3);
    expect(await contributions()).toHaveLength(1);
  });

  test("a sum board names the last result folded in, and a plain submission does not erase it", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s2", "u1", 1, at(1000));
    await store().submit(sumBoard, "all", "u1", 5, at(2000), true);
    const entry = await store().get("points", "all", "u1");
    expect(entry?.score).toBe(9);
    expect(entry?.resultId).toBe("s2");
  });

  test("a best board moves the result id only with an improving score", async () => {
    await publish(bestBoard, "s1", "u1", 10);
    await publish(bestBoard, "s2", "u1", 4, at(1000));
    expect((await store().get("best", "all", "u1"))?.resultId).toBe("s1");
    await publish(bestBoard, "s3", "u1", 12, at(2000));
    expect((await store().get("best", "all", "u1"))?.resultId).toBe("s3");
  });

  test("a plain submission that takes the score clears the result id, because the result no longer holds it", async () => {
    await publish(latestBoard, "s1", "u1", 10);
    await store().submit(latestBoard, "all", "u1", 7, at(1000), true);
    expect((await store().get("latest", "all", "u1"))?.resultId).toBeNull();
  });
});

describe("voidResult", () => {
  test("removes an entry the voided result alone submitted", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s1", "u2", 1);

    const report = await voidResult(env.DB, "s1");

    expect(report.resultId).toBe("s1");
    expect(report.removed).toEqual([
      { board: "points", window: "all", userId: "u1", score: 3 },
      { board: "points", window: "all", userId: "u2", score: 1 },
    ]);
    expect(report.adjusted).toEqual([]);
    expect(await store().get("points", "all", "u1")).toBeUndefined();
    expect(await contributions()).toEqual([]);
  });

  test("subtracts a voided result's points from a sum entry other sessions also built", async () => {
    // Removing the entry here would take the player's whole season with one bad match.
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s2", "u1", 3, at(1000));

    const report = await voidResult(env.DB, "s1");

    expect(report.removed).toEqual([]);
    expect(report.adjusted).toEqual([{ board: "points", window: "all", userId: "u1", before: 3 + 3, after: 3 }]);
    expect((await store().get("points", "all", "u1"))?.score).toBe(3);
    expect(await contributions()).toEqual([{ resultId: "s2", userId: "u1", score: 3 }]);
  });

  test("keeps a sum entry a plain submission also built, even once no result is left in it", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await store().submit(sumBoard, "all", "u1", 5, at(1000), true);

    const report = await voidResult(env.DB, "s1");

    expect(report.adjusted).toEqual([{ board: "points", window: "all", userId: "u1", before: 8, after: 5 }]);
    expect((await store().get("points", "all", "u1"))?.score).toBe(5);
  });

  test("removes a best entry while the voided result still holds its score", async () => {
    await publish(bestBoard, "s1", "u1", 10);
    const report = await voidResult(env.DB, "s1");
    expect(report.removed).toEqual([{ board: "best", window: "all", userId: "u1", score: 10 }]);
    expect(await store().get("best", "all", "u1")).toBeUndefined();
  });

  test("leaves a best entry another submission now holds", async () => {
    await publish(bestBoard, "s1", "u1", 10);
    await publish(bestBoard, "s2", "u1", 12, at(1000));

    const report = await voidResult(env.DB, "s1");

    expect(report.removed).toEqual([]);
    expect(report.adjusted).toEqual([]);
    expect((await store().get("best", "all", "u1"))?.score).toBe(12);
  });

  test("clears an adjusted entry's stored rank, so a materialized board renumbers it on its next pass", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s2", "u1", 3, at(1000));
    await env.DB.exec("UPDATE pithy_leaderboard_entries SET rank = 1");

    await voidResult(env.DB, "s1");

    expect((await store().get("points", "all", "u1"))?.rank).toBeNull();
  });

  test("a second void of the same result finds nothing and changes nothing", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s2", "u1", 3, at(1000));
    await voidResult(env.DB, "s1");

    const again = await voidResult(env.DB, "s1");

    expect(again).toEqual({ resultId: "s1", removed: [], adjusted: [] });
    expect((await store().get("points", "all", "u1"))?.score).toBe(3);
  });

  test("an entry a moderator removed takes its contributions with it, so a later void never reaches the player's next entry", async () => {
    // The bug: the removed entry's contribution outlived it, and voiding its result later subtracted those
    // points from a fresh entry that never held them, or deleted a legitimate one outright.
    await publish(sumBoard, "s1", "u1", 3);
    expect(await deleteEntry(env.DB, "points", "all", "u1")).toBe(true);
    expect(await contributions()).toEqual([]);
    await publish(sumBoard, "s2", "u1", 1, at(1000));

    const report = await voidResult(env.DB, "s1");

    expect(report).toEqual({ resultId: "s1", removed: [], adjusted: [] });
    expect((await store().get("points", "all", "u1"))?.score).toBe(1);
    expect(await contributions()).toEqual([{ resultId: "s2", userId: "u1", score: 1 }]);
  });

  test("a removed entry's result can publish again, since nothing of it is left on the board", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await deleteEntry(env.DB, "points", "all", "u1");

    expect(await publish(sumBoard, "s1", "u1", 3, at(1000))).toEqual({ recorded: true });
    expect((await store().get("points", "all", "u1"))?.score).toBe(3);
  });

  test("removing one player's entry keeps every other player's contributions", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(sumBoard, "s1", "u2", 2);
    await deleteEntry(env.DB, "points", "all", "u1");
    expect(await contributions()).toEqual([{ resultId: "s1", userId: "u2", score: 2 }]);
  });

  test("a correction takes the entry over, so a later void on a sum board leaves the operator's number", async () => {
    // The bug: the void subtracted 900 from the corrected 40 and left the player at -860, below the board.
    const bounded = LeaderboardBoard.parse({ key: "points", direction: "desc", aggregation: "sum", min: 0 });
    await publish(bounded, "r1", "alice", 900);
    await correct(bounded, "alice", 40);

    const report = await voidResult(env.DB, "r1");

    expect(report).toEqual({ resultId: "r1", removed: [], adjusted: [] });
    expect((await store().get("points", "all", "alice"))?.score).toBe(40);
    expect(await contributions()).toEqual([]);
  });

  test("a result folded in after a correction is still taken back alone", async () => {
    await publish(sumBoard, "r1", "alice", 900);
    await correct(sumBoard, "alice", 40);
    await publish(sumBoard, "r2", "alice", 10, at(6000));

    const report = await voidResult(env.DB, "r2");

    expect(report.adjusted).toEqual([{ board: "points", window: "all", userId: "alice", before: 50, after: 40 }]);
    expect((await store().get("points", "all", "alice"))?.score).toBe(40);
  });

  test("a correction takes the entry over, so a later void on a best board does not remove it", async () => {
    await publish(bestBoard, "r1", "alice", 900);
    await correct(bestBoard, "alice", 40);
    expect((await store().get("best", "all", "alice"))?.resultId).toBeNull();

    const report = await voidResult(env.DB, "r1");

    expect(report).toEqual({ resultId: "r1", removed: [], adjusted: [] });
    expect((await store().get("best", "all", "alice"))?.score).toBe(40);
  });

  test("marks the window stale when the entry it took back held a stored rank, so the refresh renumbers it", async () => {
    await publish(sumBoard, "s1", "u1", 3);
    await publish(bestBoard, "s1", "u1", 3);
    await env.DB.exec("UPDATE pithy_leaderboard_entries SET rank = 1 WHERE board_id = 'points'");

    await voidResult(env.DB, "s1");

    // A live board never stores a rank, so it has nothing to renumber and gets no row.
    expect(await staleWindows()).toEqual([{ boardId: "points", windowKey: "all" }]);
  });

  test("a result that never published reports nothing", async () => {
    expect(await voidResult(env.DB, "never")).toEqual({ resultId: "never", removed: [], adjusted: [] });
  });
});
