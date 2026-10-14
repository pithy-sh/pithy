// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { MultiplayerConfig, validateGames } from "../config/config";
import { gameSchemas } from "../session/channel";
import { BUILT_IN_GAMES } from "./builtins";
import { BattleConfig, battleGame } from "./games/battle";
import { ConnectNConfig, connectNGame } from "./games/connectN";
import { CrapsConfig, crapsGame } from "./games/craps";
import { type GameContext, type GameModel, registerGameModel } from "./model";
import { createRngState, randomSource } from "./random";

/**
 * **A built-in game's declared `view` is what its `redact` actually returns.** Held across real play rather
 * than one hand-built state, because the view changes shape as a game moves: a battle reveals on the last
 * submission, a grid fills, a craps table establishes a point and books bets. Each redaction is parsed with
 * the declared schema, and the parse must hand back exactly what went in — a key `redact` adds that the
 * schema forgot would be stripped, and fail here.
 */

/** Parse a redaction with the model's declared view, and require the parse to be the identity. */
function conforms(model: GameModel, value: unknown): void {
  const view = model.view;
  if (!view) throw new Error(`${model.kind} declares no view`);
  expect(view.parse(value)).toEqual(value);
}

async function context<Config>(config: Config, players: string[]): Promise<GameContext<Config>> {
  return { sessionId: "s", config, players, now: 0, random: randomSource(await createRngState()) };
}

describe("every built-in game declares its action and view", () => {
  test("all three, so a client can type the part that is the game", () => {
    for (const model of BUILT_IN_GAMES) {
      expect(model.action, model.kind).toBeDefined();
      expect(model.view, model.kind).toBeDefined();
    }
  });

  test("the declared action is the schema the pattern already parsed moves with", () => {
    expect(battleGame.action?.safeParse({ offense: ["fire"], defense: ["guard-ice"] }).success).toBe(true);
    expect(battleGame.action?.safeParse({ offense: "fire" }).success).toBe(false);
    expect(connectNGame.action?.safeParse({ row: 0, col: 2 }).success).toBe(true);
    expect(connectNGame.action?.safeParse({ row: "a" }).success).toBe(false);
    expect(crapsGame.action?.safeParse({ kind: "bet", bet: { type: "pass", amount: 5 } }).success).toBe(true);
    expect(crapsGame.action?.safeParse({ kind: "event" }).success).toBe(true);
    expect(crapsGame.action?.safeParse({ kind: "fold" }).success).toBe(false);
  });
});

describe("a built-in's redaction conforms to its declared view, across real play", () => {
  test("battle — before, between, and after the reveal, from both seats", async () => {
    const config = BattleConfig.parse({
      offense: {
        pick: 1,
        moves: [
          { name: "fire", power: 10 },
          { name: "ice", power: 8 },
        ],
      },
      defense: {
        pick: 1,
        moves: [
          { name: "guard-fire", blocks: "fire" },
          { name: "guard-ice", blocks: "ice" },
        ],
      },
    });
    const ctx = await context(config, ["alice", "bob"]);
    let state = battleGame.init(ctx);
    for (const viewer of ["alice", "bob"]) conforms(battleGame, battleGame.redact(ctx, state, viewer, false));
    state = battleGame.apply(ctx, state, "alice", { offense: ["fire"], defense: ["guard-ice"] }).state;
    for (const viewer of ["alice", "bob"]) conforms(battleGame, battleGame.redact(ctx, state, viewer, false));
    state = battleGame.apply(ctx, state, "bob", { offense: ["ice"], defense: ["guard-fire"] }).state;
    expect(battleGame.isComplete(ctx, state)).toBe(true);
    for (const viewer of ["alice", "bob"]) conforms(battleGame, battleGame.redact(ctx, state, viewer, true));
  });

  test("connect-n — every move of a game played to a win", async () => {
    const config = ConnectNConfig.parse({ rows: 3, cols: 3, connect: 3 });
    const ctx = await context(config, ["alice", "bob"]);
    let state = connectNGame.init(ctx);
    const moves: [string, number, number][] = [
      ["alice", 0, 0],
      ["bob", 1, 0],
      ["alice", 0, 1],
      ["bob", 1, 1],
      ["alice", 0, 2],
    ];
    for (const viewer of ["alice", "bob"]) conforms(connectNGame, connectNGame.redact(ctx, state, viewer, false));
    for (const [player, row, col] of moves) {
      state = connectNGame.apply(ctx, state, player, { row, col }).state;
      const done = connectNGame.isComplete(ctx, state);
      for (const viewer of ["alice", "bob"]) conforms(connectNGame, connectNGame.redact(ctx, state, viewer, done));
    }
    expect(connectNGame.isComplete(ctx, state)).toBe(true);
  });

  test("craps — bets booked, a point established, and rolls decided", async () => {
    const config = CrapsConfig.parse({ currency: "chips", minBet: 1 });
    const players = ["alice", "bob"];
    const ctx = await context(config, players);
    let state = crapsGame.init(ctx);
    for (const viewer of players) conforms(crapsGame, crapsGame.redact(ctx, state, viewer, false));
    state = crapsGame.apply(ctx, state, "alice", { kind: "bet", bet: { type: "pass", amount: 10 } }).state;
    state = crapsGame.apply(ctx, state, "bob", { kind: "bet", bet: { type: "dont-pass", amount: 10 } }).state;
    for (const viewer of players) conforms(crapsGame, crapsGame.redact(ctx, state, viewer, false));
    // Twenty rolls from the real seeded stream: enough to move between come-out and point, and to pass the dice.
    for (let roll = 0; roll < 20; roll++) {
      if (!state.bets.some((bet) => bet.userId === "bob" && (bet.data as { type: string }).type === "field")) {
        state = crapsGame.apply(ctx, state, "bob", { kind: "bet", bet: { type: "field", amount: 2 } }).state;
      }
      const shooter = crapsGame.redact(ctx, state, "alice", false) as { driver: string };
      state = crapsGame.apply(ctx, state, shooter.driver, { kind: "event" }).state;
      for (const viewer of players) conforms(crapsGame, crapsGame.redact(ctx, state, viewer, false));
    }
    expect(state.round.lastRoll).not.toBeNull();
  });
});

describe("a model that declares neither schema still loads", () => {
  const bare: GameModel = {
    kind: "test-bare-model",
    config: z.object({}).describe("No rules."),
    state: z.object({}).describe("No state."),
    init: () => ({}),
    apply: (_ctx, state) => ({ state }),
    isComplete: () => false,
    resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: true } }),
    redact: () => ({}),
  };

  test("it validates as a configured game, and contributes no schemas to the socket", () => {
    registerGameModel(bare);
    const games = validateGames(
      MultiplayerConfig.parse({ games: [{ key: "bare", kind: "test-bare-model", rules: {} }] }),
    );
    expect(games.map((game) => game.key)).toEqual(["bare"]);
    expect(gameSchemas(games)).toEqual({});
  });
});
