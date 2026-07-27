import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { RatingAlgorithm } from "../algorithm/algorithm";
import type { ResolvedRatingGame } from "../config/config";
import type { RatingRecord } from "../data/rating";
import type { RatingStore } from "../data/store";
import { recordOutcome } from "./record";

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

// An in-memory store so the orchestration is tested without D1 — the store round-trip is covered by the
// workers tests.
function memoryStore(): RatingStore & { rows: Map<string, RatingRecord> } {
  const rows = new Map<string, RatingRecord>();
  const keyOf = (pool: string, userId: string) => `${pool}:${userId}`;
  return {
    rows,
    async get(pool, userId) {
      return rows.get(keyOf(pool, userId));
    },
    async getMany(pool, userIds) {
      return userIds.map((id) => rows.get(keyOf(pool, id))).filter((r): r is RatingRecord => r !== undefined);
    },
    async upsert(record) {
      rows.set(keyOf(record.pool, record.userId), record);
    },
  };
}

// A stub algorithm: a player's new skill is `100 - place` (winner ranks first → higher skill), so a result
// is trivially assertable. Pure, no math to get wrong.
const Stub: RatingAlgorithm<{ skill: number }, Record<string, never>> = {
  id: "stub",
  params: z.object({}).describe("no params"),
  state: z.object({ skill: z.number().describe("skill") }).describe("stub state"),
  minPlayers: 2,
  maxPlayers: Number.POSITIVE_INFINITY,
  supportsTeams: false,
  initial: () => ({ skill: 0 }),
  update: (_p, entries, outcome) =>
    Object.fromEntries(entries.map((e) => [e.playerId, { skill: 100 - need(outcome.ranks[e.playerId]) }])),
  skill: (_p, s) => s.skill,
};

function game(overrides: Partial<ResolvedRatingGame["game"]> = {}): ResolvedRatingGame {
  return {
    algorithm: Stub as RatingAlgorithm,
    params: {},
    game: {
      key: "duel",
      algorithm: "stub",
      players: 2,
      teams: false,
      hideSkill: false,
      sharedRoomCounts: false,
      pool: "duel",
      xp: { win: 20, draw: 10, loss: 5 },
      ...overrides,
    } as ResolvedRatingGame["game"],
  };
}

describe("recordOutcome", () => {
  const at = new Date("2026-07-25T00:00:00Z");

  test("updates skill for every player and persists a row each", async () => {
    const store = memoryStore();
    const result = await recordOutcome(store, game(), { ranks: { alice: 1, bob: 2 }, at });
    const alice = result.find((r) => r.userId === "alice");
    const bob = result.find((r) => r.userId === "bob");
    expect(alice?.skill).toBe(99);
    expect(bob?.skill).toBe(98);
    expect(store.rows.size).toBe(2);
    expect(alice?.games).toBe(1);
  });

  test("awards XP by outcome for a normal (non-shared-room) game", async () => {
    const store = memoryStore();
    const result = await recordOutcome(store, game(), { ranks: { alice: 1, bob: 2 }, at });
    expect(result.find((r) => r.userId === "alice")?.xp).toBe(20); // win
    expect(result.find((r) => r.userId === "bob")?.xp).toBe(5); // loss
  });

  test("a draw awards the draw amount to tied top players", async () => {
    const store = memoryStore();
    const result = await recordOutcome(store, game(), { ranks: { alice: 1, bob: 1 }, at });
    expect(result.every((r) => r.xp === 10)).toBe(true);
  });

  test("a shared-room game withholds XP by default but still updates skill", async () => {
    const store = memoryStore();
    const result = await recordOutcome(store, game(), { ranks: { alice: 1, bob: 2 }, sharedRoom: true, at });
    expect(result.find((r) => r.userId === "alice")?.xp).toBe(0);
    expect(result.find((r) => r.userId === "alice")?.skill).toBe(99); // MMR always moves
  });

  test("a shared-room game awards XP when the game opts in", async () => {
    const store = memoryStore();
    const result = await recordOutcome(store, game({ sharedRoomCounts: true }), {
      ranks: { alice: 1, bob: 2 },
      sharedRoom: true,
      at,
    });
    expect(result.find((r) => r.userId === "alice")?.xp).toBe(20);
  });

  test("XP accumulates monotonically across games", async () => {
    const store = memoryStore();
    await recordOutcome(store, game(), { ranks: { alice: 1, bob: 2 }, at });
    const second = await recordOutcome(store, game(), { ranks: { alice: 2, bob: 1 }, at });
    expect(second.find((r) => r.userId === "alice")?.xp).toBe(25); // 20 (win) + 5 (loss)
    expect(second.find((r) => r.userId === "alice")?.games).toBe(2);
  });

  test("classifies a level when the game defines a ladder", async () => {
    const store = memoryStore();
    const result = await recordOutcome(
      store,
      game({
        levels: [
          { key: "rookie", from: 0 },
          { key: "pro", from: 15 },
        ],
      }),
      { ranks: { alice: 1, bob: 2 }, at },
    );
    expect(result.find((r) => r.userId === "alice")?.level).toBe("pro"); // 20 xp
    expect(result.find((r) => r.userId === "bob")?.level).toBe("rookie"); // 5 xp
  });

  test("rejects an outcome whose roster size does not match the game", async () => {
    const store = memoryStore();
    await expect(recordOutcome(store, game(), { ranks: { alice: 1, bob: 2, carol: 3 }, at })).rejects.toThrow(
      /expects 2 players/,
    );
  });
});
