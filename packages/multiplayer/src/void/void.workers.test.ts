// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ConflictError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { buildRegistryFromCapabilities } from "@pithy-sh/core/src/migrations/capabilitySets";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { LeaderboardVoidReport } from "@pithy-sh/leaderboard/src/entry/voidReport";
import { rating } from "@pithy-sh/rating/src/capability";
import { ratingStore } from "@pithy-sh/rating/src/data/store";
import { ratingDatabase } from "@pithy-sh/rating/src/data/tables";
import { RatingVoidReport } from "@pithy-sh/rating/src/http/responses";
import { recordOutcome } from "@pithy-sh/rating/src/record/record";
import { beforeEach, describe, expect, test } from "vitest";
import { multiplayer } from "../capability";
import { resultStore } from "../data/store";
import { multiplayerPeers, type VoidConsumer } from "../session/peers";
import type { GameSnapshot } from "../session/state";
import { runVoidConsumer, VOID_LEASE_MS, voidMultiplayerResult } from "./void";

/**
 * The void cascade over the real consumers (#820, with #817 and #818): a session played to a win publishes to a
 * real leaderboard, its outcome is rated by a real rating, and voiding the result takes both back, consumer by
 * consumer. Every table is the one each capability's own migrations build.
 */

const BOARD = leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] });
const RATING = rating({ games: [{ key: "ttt", algorithm: "elo" }] });
const MULTIPLAYER = multiplayer({
  games: [
    {
      key: "ttt",
      kind: "connect-n",
      rules: { rows: 3, cols: 3, connect: 3 },
      leaderboard: { board: "wins", points: { win: 3, draw: 1, loss: 0 } },
    },
  ],
});
const COMPOSED: Capability[] = [BOARD, RATING, MULTIPLAYER];
for (const capability of COMPOSED) capability.compose?.({ capabilities: COMPOSED });

/** The consumers the composition found: leaderboard, then rating. */
const consumers = (): readonly VoidConsumer[] => multiplayerPeers().voidConsumers ?? [];

const SNAPSHOT: GameSnapshot = {
  key: "ttt",
  kind: "connect-n",
  mode: "match",
  players: 2,
  turnTimeoutMs: null,
  leaderboard: {
    board: "wins",
    points: { win: 3, draw: 1, loss: 0 },
    direction: "desc",
    aggregation: "sum",
  } as GameSnapshot["leaderboard"],
  rules: { rows: 3, cols: 3, connect: 3 },
};

beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pithy_%'",
  ).all<{ name: string }>();
  for (const { name } of results) await env.DB.exec(`DROP TABLE IF EXISTS ${name}`);
  for (const provider of Object.values(buildRegistryFromCapabilities(COMPOSED))) {
    await runMigrations(env.DB, provider);
  }
});

/** Play one game of tic-tac-toe to an x win, and rate it under the session's id. Answers the session id. */
async function playedAndRated(x: string, o: string): Promise<string> {
  const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
  const { sessionId } = await stub.create(SNAPSHOT, x);
  await stub.join(o);
  for (const [player, row, col] of [
    [x, 0, 0],
    [o, 1, 0],
    [x, 0, 1],
    [o, 1, 1],
    [x, 0, 2],
  ] as const) {
    await stub.action(player, { row, col });
  }
  const [game] = RATING.ratingGames;
  if (!game) throw new Error("no rated game");
  await recordOutcome(ratingStore(ratingDatabase(env.DB)), game, {
    ranks: { [x]: 1, [o]: 2 },
    resultId: sessionId,
    at: new Date(),
  });
  return sessionId;
}

/** A player's score on the all-time `wins` board, or undefined when they have no entry. */
async function score(userId: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    "SELECT score FROM pithy_leaderboard_entries WHERE board_id = 'wins' AND user_id = ?",
  )
    .bind(userId)
    .first<{ score: number }>();
  return row?.score ?? undefined;
}

/** A player's skill in the `ttt` pool. */
async function skill(userId: string): Promise<number | undefined> {
  return (await ratingStore(ratingDatabase(env.DB)).get("ttt", userId))?.skill;
}

describe("voidMultiplayerResult, over the real leaderboard and rating", () => {
  test("marks the result void and calls every composed consumer with its id, reporting each one", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    expect(await score("ada")).toBe(3);
    const rated = await skill("ada");
    expect(rated).not.toBe(await skill("bo"));

    const outcome = await voidMultiplayerResult(env.DB, consumers(), { sessionId, idempotencyKey: "k1" }, new Date());

    expect(outcome.replayed).toBe(false);
    expect(outcome.result.voidedAt).toBeInstanceOf(Date);
    expect(outcome.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
      { consumer: "rating", status: "done" },
    ]);
    // Each report is in its consumer's own exported shape.
    const board = LeaderboardVoidReport.parse(outcome.consumers[0]?.report);
    expect(board.removed.map((entry) => entry.userId).sort()).toEqual(["ada", "bo"]);
    const ratings = RatingVoidReport.parse(outcome.consumers[1]?.report);
    expect(ratings.outcomes).toBe(1);
    expect(ratings.players.map((player) => player.userId).sort()).toEqual(["ada", "bo"]);

    // The board and the ratings are as if the game never counted.
    expect(await score("ada")).toBeUndefined();
    expect(await skill("ada")).toBe(await skill("bo"));
    expect((await resultStore(env.DB).get(sessionId))?.voidConsumers).toEqual([
      { consumer: "leaderboard", status: "done", error: null },
      { consumer: "rating", status: "done", error: null },
    ]);
  });

  test("voiding a voided result changes nothing: the same key, or a new one", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    await voidMultiplayerResult(env.DB, consumers(), { sessionId, idempotencyKey: "k1" }, new Date());
    const calls: string[] = [];
    const counting = consumers().map((consumer) => ({
      ...consumer,
      voidResult: async () => {
        calls.push(consumer.name);
        return {};
      },
    }));
    const again = await voidMultiplayerResult(env.DB, counting, { sessionId, idempotencyKey: "k1" }, new Date());
    const fresh = await voidMultiplayerResult(env.DB, counting, { sessionId, idempotencyKey: "k2" }, new Date());
    for (const outcome of [again, fresh]) {
      expect(outcome.replayed).toBe(true);
      expect(outcome.consumers.map((entry) => entry.status)).toEqual(["done", "done"]);
      expect(outcome.consumers.every((entry) => entry.report === undefined)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("a failed consumer is named, never folded into success, and the void still stands", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const broken: VoidConsumer[] = [
      consumers()[0] as VoidConsumer,
      {
        name: "rating",
        voidResult: () => Promise.reject(new Error("D1 is busy")),
      },
    ];
    const outcome = await voidMultiplayerResult(env.DB, broken, { sessionId, idempotencyKey: "k1" }, new Date());
    expect(outcome.replayed).toBe(false);
    expect(outcome.consumers.map(({ consumer, status, error }) => ({ consumer, status, error }))).toEqual([
      { consumer: "leaderboard", status: "done", error: null },
      {
        consumer: "rating",
        status: "failed",
        error: { code: "core/internal", message: "The rating consumer failed." },
      },
    ]);
    expect(outcome.result.voidedAt).toBeInstanceOf(Date);
    // The board came back; the rating did not.
    expect(await score("ada")).toBeUndefined();
    expect(await skill("ada")).not.toBe(await skill("bo"));

    // The same key is the same act: nothing runs again.
    const replayed = await voidMultiplayerResult(env.DB, consumers(), { sessionId, idempotencyKey: "k1" }, new Date());
    expect(replayed.replayed).toBe(true);
    expect(replayed.consumers.map((entry) => entry.status)).toEqual(["done", "failed"]);

    // A new key runs the failed consumer, and only it.
    const retried = await voidMultiplayerResult(env.DB, consumers(), { sessionId, idempotencyKey: "k2" }, new Date());
    expect(retried.replayed).toBe(false);
    expect(retried.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "rating", status: "done" },
    ]);
    expect(await skill("ada")).toBe(await skill("bo"));
    expect(retried.result.voidConsumers?.map((entry) => entry.status)).toEqual(["done", "done"]);
    // And the retry's key now names the void, so it replays too.
    expect(
      (await voidMultiplayerResult(env.DB, consumers(), { sessionId, idempotencyKey: "k2" }, new Date())).replayed,
    ).toBe(true);
  });

  test("a key a retry took over stays spent: replayed, it runs nothing again, and it voids no other result", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const other = await playedAndRated("cy", "dee");
    let runs = 0;
    const failing: VoidConsumer[] = [
      consumers()[0] as VoidConsumer,
      {
        name: "rating",
        voidResult: () => {
          runs++;
          return Promise.reject(new Error("D1 is busy"));
        },
      },
    ];
    const at = new Date();
    await voidMultiplayerResult(env.DB, failing, { sessionId, idempotencyKey: "k1" }, at);
    const retried = await voidMultiplayerResult(env.DB, failing, { sessionId, idempotencyKey: "k2" }, at);
    expect(retried.replayed).toBe(false);
    expect(runs).toBe(2);

    // The first request's answer was lost, and its client sends k1 again: the same act, so nothing runs.
    const replayed = await voidMultiplayerResult(env.DB, failing, { sessionId, idempotencyKey: "k1" }, at);
    expect(replayed.replayed).toBe(true);
    expect(runs).toBe(2);
    // And k1, spent on this result, cannot void another one.
    await expect(
      voidMultiplayerResult(env.DB, [], { sessionId: other, idempotencyKey: "k1" }, at),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await resultStore(env.DB).get(other))?.voidedAt).toBeNull();
  });

  test("a new key while the first void is still running is a conflict, and runs no consumer a second time", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const [board, rated] = consumers() as [VoidConsumer, VoidConsumer];
    let boardRuns = 0;
    let ratingRuns = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: VoidConsumer[] = [
      {
        name: "leaderboard",
        voidResult: async (d1, resultId, now) => {
          boardRuns++;
          entered();
          await gate;
          return board.voidResult?.(d1, resultId, now) ?? {};
        },
      },
      {
        name: "rating",
        voidResult: (d1, resultId, now) => {
          ratingRuns++;
          return rated.voidResult?.(d1, resultId, now) ?? Promise.resolve({});
        },
      },
    ];
    const at = new Date();
    const first = voidMultiplayerResult(env.DB, slow, { sessionId, idempotencyKey: "k1" }, at);
    await started;

    // A second operator, or a client that mints a key per click: the first void is still taking the board back.
    await expect(
      voidMultiplayerResult(env.DB, slow, { sessionId, idempotencyKey: "k2" }, new Date(at.getTime() + 1000)),
    ).rejects.toMatchObject({ payload: { code: "core/conflict", message: "A void of this result is still running." } });

    release();
    const outcome = await first;
    expect(outcome.consumers.map((entry) => entry.status)).toEqual(["done", "done"]);
    expect(boardRuns).toBe(1);
    expect(ratingRuns).toBe(1);
    // The board lost the result's points once, not twice.
    expect(await score("ada")).toBeUndefined();
    expect((await resultStore(env.DB).get(sessionId))?.voidConsumers?.map((entry) => entry.status)).toEqual([
      "done",
      "done",
    ]);
    // The key the conflict was sent with was not spent, so it can still be used.
    expect(await resultStore(env.DB).byVoidKey("k2")).toBeUndefined();
  });

  test("a new key while a retry is still running is a conflict too, and runs no consumer a second time", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const [board, rated] = consumers() as [VoidConsumer, VoidConsumer];
    let boardRuns = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const at = new Date();
    // The first void takes the rating back and fails on the board, so nothing is left pending.
    const failing: VoidConsumer[] = [
      { name: "leaderboard", voidResult: () => Promise.reject(new Error("D1 is busy")) },
      rated,
    ];
    await voidMultiplayerResult(env.DB, failing, { sessionId, idempotencyKey: "k1" }, at);
    const slow: VoidConsumer[] = [
      {
        name: "leaderboard",
        voidResult: async (d1, resultId, now) => {
          boardRuns++;
          entered();
          await gate;
          return board.voidResult?.(d1, resultId, now) ?? {};
        },
      },
      rated,
    ];
    const retry = voidMultiplayerResult(
      env.DB,
      slow,
      { sessionId, idempotencyKey: "k2" },
      new Date(at.getTime() + 1000),
    );
    await started;

    // The retry holds the board it is running, so a third key cannot run it beside it.
    expect((await resultStore(env.DB).get(sessionId))?.voidConsumers?.map((entry) => entry.status)).toEqual([
      "pending",
      "done",
    ]);
    await expect(
      voidMultiplayerResult(env.DB, slow, { sessionId, idempotencyKey: "k3" }, new Date(at.getTime() + 2000)),
    ).rejects.toMatchObject({ payload: { code: "core/conflict", message: "A void of this result is still running." } });

    release();
    const outcome = await retry;
    expect(outcome.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
    ]);
    expect(boardRuns).toBe(1);
    expect(await score("ada")).toBeUndefined();
    expect((await resultStore(env.DB).get(sessionId))?.voidConsumers?.map((entry) => entry.status)).toEqual([
      "done",
      "done",
    ]);
    expect(await resultStore(env.DB).byVoidKey("k3")).toBeUndefined();
  });

  test("a retry that stopped leaves its consumers pending, run again once the retry's lease has passed", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const [, rated] = consumers() as [VoidConsumer, VoidConsumer];
    const at = new Date();
    const failing: VoidConsumer[] = [
      { name: "leaderboard", voidResult: () => Promise.reject(new Error("D1 is busy")) },
      rated,
    ];
    await voidMultiplayerResult(env.DB, failing, { sessionId, idempotencyKey: "k1" }, at);
    // The retry claims the void and is gone before its consumer answers: a deploy, a dropped isolate.
    const retriedAt = new Date(at.getTime() + 1000);
    const unfinished = [
      { consumer: "leaderboard", status: "pending" as const, error: null },
      { consumer: "rating", status: "done" as const, error: null },
    ];
    expect(await resultStore(env.DB).claimRetry(sessionId, "k1", "k2", retriedAt, unfinished)).toBe(true);

    await expect(
      voidMultiplayerResult(
        env.DB,
        consumers(),
        { sessionId, idempotencyKey: "k3" },
        new Date(retriedAt.getTime() + VOID_LEASE_MS - 1),
      ),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    const after = await voidMultiplayerResult(
      env.DB,
      consumers(),
      { sessionId, idempotencyKey: "k3" },
      new Date(retriedAt.getTime() + VOID_LEASE_MS),
    );
    expect(after.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
    ]);
    expect(await score("ada")).toBeUndefined();
  });

  test("a consumer left pending by a void that stopped is run again once the void's lease has passed", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const at = new Date();
    // A void that marked the result and stopped before either consumer answered.
    await resultStore(env.DB).markVoided(
      sessionId,
      "k1",
      [
        { consumer: "leaderboard", status: "pending", error: null },
        { consumer: "rating", status: "pending", error: null },
      ],
      at,
    );

    await expect(
      voidMultiplayerResult(
        env.DB,
        consumers(),
        { sessionId, idempotencyKey: "k2" },
        new Date(at.getTime() + VOID_LEASE_MS - 1),
      ),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });

    const retried = await voidMultiplayerResult(
      env.DB,
      consumers(),
      { sessionId, idempotencyKey: "k3" },
      new Date(at.getTime() + VOID_LEASE_MS),
    );
    expect(retried.replayed).toBe(false);
    expect(retried.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
      { consumer: "rating", status: "done" },
    ]);
    expect(await score("ada")).toBeUndefined();
    expect(await skill("ada")).toBe(await skill("bo"));
  });

  test("a pending consumer on a void that holds no key has no lease to wait out, and runs again", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    await env.DB.prepare("UPDATE pithy_multiplayer_results SET voided_at = ?, void_consumers = ? WHERE session_id = ?")
      .bind(Date.now(), JSON.stringify([{ consumer: "leaderboard", status: "pending", error: null }]), sessionId)
      .run();
    const retried = await voidMultiplayerResult(
      env.DB,
      [consumers()[0] as VoidConsumer],
      { sessionId, idempotencyKey: "k1" },
      new Date(),
    );
    expect(retried.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
    ]);
    expect(await score("ada")).toBeUndefined();
  });

  test("a failed consumer no longer composed when the void is retried is named failed, and recorded", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const broken: VoidConsumer[] = [
      consumers()[0] as VoidConsumer,
      { name: "rating", voidResult: () => Promise.reject(new Error("D1 is busy")) },
    ];
    await voidMultiplayerResult(env.DB, broken, { sessionId, idempotencyKey: "k1" }, new Date());

    // Rating was taken out of the composition between the void and its retry.
    const retried = await voidMultiplayerResult(
      env.DB,
      [consumers()[0] as VoidConsumer],
      { sessionId, idempotencyKey: "k2" },
      new Date(),
    );
    const precondition = {
      code: "core/precondition_failed",
      message: "No rating is composed in this Worker any more.",
    };
    expect(retried.replayed).toBe(false);
    expect(retried.consumers).toEqual([{ consumer: "rating", status: "failed", error: precondition }]);
    expect((await resultStore(env.DB).get(sessionId))?.voidConsumers).toEqual([
      { consumer: "leaderboard", status: "done", error: null },
      { consumer: "rating", status: "failed", error: precondition },
    ]);
  });

  test("a consumer that throws a PithyError keeps its own code and message", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const outcome = await runVoidConsumer(
      env.DB,
      {
        name: "rating",
        voidResult: () => Promise.reject(new NotFoundError({ message: "No rated outcome has that result id." })),
      },
      "rating",
      sessionId,
      new Date(),
    );
    expect(outcome).toEqual({
      consumer: "rating",
      status: "failed",
      error: { code: "core/not_found", message: "No rated outcome has that result id." },
    });
  });

  test("a consumer too old to void is named failed, with what to upgrade", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const outcome = await voidMultiplayerResult(
      env.DB,
      [{ name: "leaderboard" }],
      { sessionId, idempotencyKey: "k1" },
      new Date(),
    );
    expect(outcome.consumers).toEqual([
      {
        consumer: "leaderboard",
        status: "failed",
        error: {
          code: "core/precondition_failed",
          message: "The composed leaderboard is too old to void a result. Upgrade @pithy-sh/leaderboard.",
        },
      },
    ]);
  });

  test("with no consumer composed, the result is voided and the list is empty", async () => {
    const sessionId = await playedAndRated("ada", "bo");
    const outcome = await voidMultiplayerResult(env.DB, [], { sessionId, idempotencyKey: "k1" }, new Date());
    expect(outcome).toMatchObject({ replayed: false, consumers: [] });
    expect(outcome.result.voidedAt).toBeInstanceOf(Date);
  });

  test("a session with no result is a 404, and a key spent on another result is a conflict", async () => {
    await expect(
      voidMultiplayerResult(env.DB, [], { sessionId: "nope", idempotencyKey: "k1" }, new Date()),
    ).rejects.toBeInstanceOf(NotFoundError);
    const first = await playedAndRated("ada", "bo");
    const second = await playedAndRated("cy", "dee");
    await voidMultiplayerResult(env.DB, [], { sessionId: first, idempotencyKey: "k1" }, new Date());
    await expect(
      voidMultiplayerResult(env.DB, [], { sessionId: second, idempotencyKey: "k1" }, new Date()),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
