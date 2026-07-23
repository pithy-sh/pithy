import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { GameContext } from "../model";
import { randomSource } from "../random";
import { BattleConfig, battleGame, type Move, scoreBattle, validateMove } from "./battle";

const config = BattleConfig.parse({
  offense: {
    pick: 2,
    moves: [
      { name: "fire", power: 10 },
      { name: "ice", power: 8 },
      { name: "wind", power: 6 },
    ],
  },
  defense: {
    pick: 2,
    moves: [
      { name: "guard-fire", blocks: "fire" },
      { name: "guard-ice", blocks: "ice" },
      { name: "guard-wind", blocks: "wind" },
    ],
  },
});
const ctx = (players: string[]): GameContext<BattleConfig> => ({
  sessionId: "s",
  config,
  players,
  now: 0,
  random: randomSource({ seed: "x", seedHash: "x", cursor: 0 }),
});
const commit = (offense: string[], defense: string[]): Move => ({ offense, defense });

describe("validateMove", () => {
  test("rejects wrong count, unknown move, and duplicates", () => {
    expect(() => validateMove(config, commit(["fire"], ["guard-fire", "guard-wind"]))).toThrow(/exactly 2 offensive/);
    expect(() => validateMove(config, commit(["fire", "meteor"], ["guard-fire", "guard-wind"]))).toThrow(
      /"meteor" is not/,
    );
    expect(() => validateMove(config, commit(["fire", "fire"], ["guard-fire", "guard-wind"]))).toThrow(/distinct/);
  });
  test("a valid move passes", () => {
    expect(() => validateMove(config, commit(["fire", "ice"], ["guard-fire", "guard-wind"]))).not.toThrow();
  });
});

describe("scoreBattle", () => {
  test("an unblocked attacker outscores a blocked one", () => {
    const outcome = scoreBattle(
      config,
      {
        alice: commit(["fire", "ice"], ["guard-wind", "guard-ice"]),
        bob: commit(["wind", "fire"], ["guard-fire", "guard-wind"]),
      },
      ["alice", "bob"],
    );
    expect(outcome.scores).toEqual({ alice: 8, bob: 10 }); // alice's fire blocked (8), bob's wind blocked (10)
    expect(outcome.winnerUserId).toBe("bob");
  });
  test("equal scores draw", () => {
    const outcome = scoreBattle(
      config,
      {
        alice: commit(["fire", "ice"], ["guard-wind", "guard-fire"]),
        bob: commit(["wind", "ice"], ["guard-wind", "guard-fire"]),
      },
      ["alice", "bob"],
    );
    expect(outcome.draw).toBe(true);
    expect(outcome.winnerUserId).toBeNull();
  });
  test("N players: an offense is blocked if ANY opponent defended it", () => {
    const outcome = scoreBattle(
      config,
      {
        alice: commit(["fire", "ice"], ["guard-wind", "guard-ice"]),
        bob: commit(["wind", "fire"], ["guard-fire", "guard-wind"]),
        carol: commit(["ice", "wind"], ["guard-fire", "guard-ice"]),
      },
      ["alice", "bob", "carol"],
    );
    expect(outcome.scores).toEqual({ alice: 0, bob: 0, carol: 0 }); // everyone's offense is blocked by someone
    expect(outcome.draw).toBe(true);
  });
});

describe("battleGame (on the simultaneous pattern)", () => {
  test("collects one submission per player, rejects a second, and resolves when all are in", () => {
    let state = battleGame.init(ctx(["alice", "bob"]));
    state = battleGame.apply(
      ctx(["alice", "bob"]),
      state,
      "alice",
      commit(["fire", "ice"], ["guard-fire", "guard-wind"]),
    ).state;
    expect(battleGame.isComplete(ctx(["alice", "bob"]), state)).toBe(false);
    expect(() =>
      battleGame.apply(ctx(["alice", "bob"]), state, "alice", commit(["fire", "ice"], ["guard-fire", "guard-wind"])),
    ).toThrow(PithyError);
    state = battleGame.apply(
      ctx(["alice", "bob"]),
      state,
      "bob",
      commit(["wind", "fire"], ["guard-fire", "guard-wind"]),
    ).state;
    expect(battleGame.isComplete(ctx(["alice", "bob"]), state)).toBe(true);
    expect(battleGame.resolve(ctx(["alice", "bob"]), state).outcome.winnerUserId).toBeDefined();
  });

  test("redact hides opponents' submissions until the reveal", () => {
    const state = { submissions: { alice: commit(["fire", "ice"], ["guard-fire", "guard-wind"]) } };
    const bobSees = battleGame.redact(ctx(["alice", "bob"]), state, "bob", false) as {
      opponents: { submission: unknown }[];
    };
    expect(bobSees.opponents[0]?.submission).toBeNull();
    const revealed = battleGame.redact(ctx(["alice", "bob"]), state, "bob", true) as {
      opponents: { submission: unknown }[];
    };
    expect(revealed.opponents[0]?.submission).toEqual(state.submissions.alice);
  });
});
