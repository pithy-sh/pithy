import { describe, expect, test } from "vitest";
import { z } from "zod";
import "./builtins";
import { type GameModel, playerBounds, registeredKinds, registerGameModel, resolveModel } from "./model";

describe("game-model registry", () => {
  test("the two built-in models are registered by kind", () => {
    expect(registeredKinds()).toEqual(expect.arrayContaining(["battle", "connect-n"]));
    expect(resolveModel("battle")?.kind).toBe("battle");
    expect(resolveModel("connect-n")?.kind).toBe("connect-n");
  });

  test("an unregistered kind resolves to undefined", () => {
    expect(resolveModel("does-not-exist")).toBeUndefined();
  });

  test("registerGameModel adds a custom model, resolvable by kind", () => {
    const custom: GameModel = {
      kind: "test-only-model",
      config: z.object({}).describe("empty"),
      state: z.object({}).describe("empty"),
      init: () => ({}),
      apply: (_c, s) => ({ state: s }),
      isComplete: () => true,
      resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: true } }),
      redact: () => ({}),
    };
    registerGameModel(custom);
    expect(resolveModel("test-only-model")).toBe(custom);
  });

  test("playerBounds defaults to [2, ∞) and honors declared bounds", () => {
    expect(playerBounds({ minPlayers: undefined, maxPlayers: undefined } as GameModel)).toEqual({
      min: 2,
      max: Number.POSITIVE_INFINITY,
    });
    expect(playerBounds({ minPlayers: 3, maxPlayers: 6 } as GameModel)).toEqual({ min: 3, max: 6 });
  });
});
