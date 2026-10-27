// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { freshMultiplayerDatabase } from "../test-utils/database";
import type { NewMultiplayerResult, VoidConsumerStatus } from "./result";
import { isUniqueViolation, resultStore } from "./store";

beforeEach(async () => {
  await freshMultiplayerDatabase(env.DB);
});

const store = () => resultStore(env.DB);

function result(sessionId: string, gameKey: string, resolvedAt: number): NewMultiplayerResult {
  return {
    id: 0,
    sessionId,
    gameKey,
    status: "resolved",
    players: ["ada", "bo"],
    scores: { ada: 1, bo: 0 },
    winnerUserId: "ada",
    draw: false,
    createdAt: new Date(resolvedAt - 100),
    resolvedAt: new Date(resolvedAt),
  };
}

describe("resultStore", () => {
  test("a written result counts until it is voided", async () => {
    await store().write(result("s1", "duel", 1_000));
    expect(await store().get("s1")).toMatchObject({ voidedAt: null, voidKey: null, voidConsumers: null });
  });

  test("markVoided marks once: the first call does it, a second finds it void already", async () => {
    await store().write(result("s1", "duel", 1_000));
    const consumers = [{ consumer: "leaderboard", status: "pending" as const, error: null }];
    expect(await store().markVoided("s1", "k1", consumers, new Date(5_000))).toBe(true);
    expect(await store().markVoided("s1", "k2", [], new Date(6_000))).toBe(false);
    const voided = await store().get("s1");
    expect(voided).toMatchObject({ voidedAt: new Date(5_000), voidKey: "k1", voidConsumers: consumers });
    expect((await store().byVoidKey("k1"))?.sessionId).toBe("s1");
    expect(await store().byVoidKey("k2")).toBeUndefined();
  });

  test("a void key spent on one result cannot void another", async () => {
    await store().write(result("s1", "duel", 1_000));
    await store().write(result("s2", "duel", 2_000));
    await store().markVoided("s1", "k1", [], new Date());
    const error = await store()
      .markVoided("s2", "k1", [], new Date())
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(error)).toBe(true);
  });

  test("recordConsumers rewrites what each consumer did", async () => {
    await store().write(result("s1", "duel", 1_000));
    await store().markVoided("s1", "k1", [{ consumer: "rating", status: "pending", error: null }], new Date());
    const done = [{ consumer: "rating", status: "done" as const, error: null }];
    await store().recordConsumers("s1", done);
    expect((await store().get("s1"))?.voidConsumers).toEqual(done);
  });

  test("list pages most recently ended first, by game and by whether the result counts", async () => {
    await store().write(result("s1", "duel", 1_000));
    await store().write(result("s2", "race", 2_000));
    await store().write(result("s3", "duel", 3_000));
    await store().markVoided("s3", "k", [], new Date());

    const first = await store().list({ limit: 2 });
    expect(first.items.map((row) => row.sessionId)).toEqual(["s3", "s2"]);
    const next = await store().list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(next.items.map((row) => row.sessionId)).toEqual(["s1"]);
    expect(next.nextCursor).toBeNull();

    expect((await store().list({ gameKey: "duel" })).items.map((row) => row.sessionId)).toEqual(["s3", "s1"]);
    expect((await store().list({ voided: true })).items.map((row) => row.sessionId)).toEqual(["s3"]);
    expect((await store().list({ voided: false })).items.map((row) => row.sessionId)).toEqual(["s2", "s1"]);
  });
});

describe("claimRetry", () => {
  const at = new Date(9_000);
  const none: VoidConsumerStatus[] = [];
  async function voided(sessionId: string, key: string): Promise<void> {
    await store().write(result(sessionId, "duel", 1_000));
    await store().markVoided(sessionId, key, [], new Date(5_000));
  }

  test("hands the void to a new key, and the key it held stays spent on the result", async () => {
    await voided("s1", "k1");
    expect(await store().claimRetry("s1", "k1", "k2", at, none)).toBe(true);
    expect((await store().get("s1"))?.voidKey).toBe("k2");
    expect((await store().byVoidKey("k2"))?.sessionId).toBe("s1");
    expect((await store().byVoidKey("k1"))?.sessionId).toBe("s1");
  });

  test("records the consumers it is handed, so the retry holds what it re-runs as pending", async () => {
    await store().write(result("s1", "duel", 1_000));
    await store().markVoided(
      "s1",
      "k1",
      [
        { consumer: "leaderboard", status: "failed", error: { code: "core/internal", message: "Busy." } },
        { consumer: "rating", status: "done", error: null },
      ],
      new Date(5_000),
    );
    const claimed: VoidConsumerStatus[] = [
      { consumer: "leaderboard", status: "pending", error: null },
      { consumer: "rating", status: "done", error: null },
    ];
    expect(await store().claimRetry("s1", "k1", "k2", at, claimed)).toBe(true);
    expect((await store().get("s1"))?.voidConsumers).toEqual(claimed);
  });

  test("a claim that loses records nothing over the winner's consumers", async () => {
    await voided("s1", "k1");
    const won: VoidConsumerStatus[] = [{ consumer: "leaderboard", status: "pending", error: null }];
    await store().claimRetry("s1", "k1", "k2", at, won);
    expect(
      await store().claimRetry("s1", "k1", "k3", at, [{ consumer: "leaderboard", status: "done", error: null }]),
    ).toBe(false);
    expect((await store().get("s1"))?.voidConsumers).toEqual(won);
  });

  test("a claim from a key the void no longer holds loses, and spends nothing", async () => {
    await voided("s1", "k1");
    await store().claimRetry("s1", "k1", "k2", at, none);
    expect(await store().claimRetry("s1", "k1", "k3", at, none)).toBe(false);
    expect((await store().get("s1"))?.voidKey).toBe("k2");
    expect(await store().byVoidKey("k3")).toBeUndefined();
  });

  test("a void that holds no key is claimed from null, and only from null", async () => {
    await store().write(result("s1", "duel", 1_000));
    await env.DB.prepare("UPDATE pithy_multiplayer_results SET voided_at = 5000 WHERE session_id = 's1'").run();
    expect(await store().claimRetry("s1", "k0", "k8", at, none)).toBe(false);
    expect(await store().claimRetry("s1", null, "k9", at, none)).toBe(true);
    expect((await store().byVoidKey("k9"))?.sessionId).toBe("s1");
  });

  test("a key already spent — on another result, or earlier on this one — is a unique violation", async () => {
    await voided("s1", "k1");
    await voided("s2", "other");
    const elsewhere = await store()
      .claimRetry("s1", "k1", "other", at, none)
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(elsewhere)).toBe(true);
    await store().claimRetry("s1", "k1", "k2", at, none);
    const earlier = await store()
      .claimRetry("s1", "k2", "k1", at, none)
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(earlier)).toBe(true);
    expect((await store().get("s1"))?.voidKey).toBe("k2");
  });

  test("spentAt answers when each key was spent, the void's and the retry's alike", async () => {
    await voided("s1", "k1");
    await store().claimRetry("s1", "k1", "k2", at, none);
    expect(await store().spentAt("k1")).toEqual(new Date(5_000));
    expect(await store().spentAt("k2")).toEqual(at);
    expect(await store().spentAt("never")).toBeUndefined();
  });

  test("a result that still counts has no void to claim", async () => {
    await store().write(result("s1", "duel", 1_000));
    expect(await store().claimRetry("s1", null, "k1", at, none)).toBe(false);
    expect(await store().byVoidKey("k1")).toBeUndefined();
  });
});

describe("isUniqueViolation", () => {
  test("finds SQLite's wording on the error or any cause beneath it, and nothing else", () => {
    expect(isUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: x.y"))).toBe(true);
    expect(isUniqueViolation(new Error("wrapped", { cause: new Error("UNIQUE constraint failed") }))).toBe(true);
    expect(isUniqueViolation(new Error("no such table"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
