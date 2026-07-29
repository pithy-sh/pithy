import { describe, expect, test } from "vitest";
import type { GameContext } from "../model";
import { randomSource } from "../random";
import { ConnectNConfig, connectNGame, findWinner } from "./connectN";

const ttt = ConnectNConfig.parse({ rows: 3, cols: 3, connect: 3 });
const ctx = (players: string[], config = ttt): GameContext<ConnectNConfig> => ({
  sessionId: "s",
  config,
  players,
  now: 0,
  random: randomSource({ seed: "x", seedHash: "x", cursor: 0 }),
});

type State = ReturnType<typeof connectNGame.init>;
function play(players: string[], config: ConnectNConfig, moves: [string, number, number][]): State {
  const c = ctx(players, config);
  let state = connectNGame.init(c);
  for (const [player, row, col] of moves) state = connectNGame.apply(c, state, player, { row, col }).state;
  return state;
}

describe("findWinner", () => {
  test("detects a row, a column, and a diagonal, and nothing otherwise", () => {
    expect(
      findWinner(
        [
          ["a", "a", "a"],
          [null, null, null],
          [null, null, null],
        ],
        3,
      ),
    ).toBe("a");
    expect(
      findWinner(
        [
          ["a", null, null],
          ["a", null, null],
          ["a", null, null],
        ],
        3,
      ),
    ).toBe("a");
    expect(
      findWinner(
        [
          ["a", null, null],
          [null, "a", null],
          [null, null, "a"],
        ],
        3,
      ),
    ).toBe("a");
    expect(
      findWinner(
        [
          ["a", "b", "a"],
          [null, null, null],
          [null, null, null],
        ],
        3,
      ),
    ).toBeNull();
  });
});

describe("connectN config", () => {
  test("rejects a connect longer than the board; accepts Connect Four", () => {
    expect(ConnectNConfig.safeParse({ rows: 3, cols: 3, connect: 4 }).success).toBe(false);
    expect(ConnectNConfig.safeParse({ rows: 7, cols: 6, connect: 4 }).success).toBe(true);
  });
});

describe("connectNGame (on the turn-based pattern)", () => {
  test("enforces turn order and rejects an off-board or occupied cell", () => {
    const c = ctx(["x", "o"]);
    let state = connectNGame.init(c);
    expect(() => connectNGame.apply(c, state, "o", { row: 0, col: 0 })).toThrow(/not your turn/); // x is first
    expect(() => connectNGame.apply(c, state, "x", { row: 9, col: 0 })).toThrow(/off the board/);
    state = connectNGame.apply(c, state, "x", { row: 0, col: 0 }).state;
    expect(() => connectNGame.apply(c, state, "o", { row: 0, col: 0 })).toThrow(/already taken/);
  });

  test("a line of three wins tic-tac-toe", () => {
    const state = play(["x", "o"], ttt, [
      ["x", 0, 0],
      ["o", 1, 0],
      ["x", 0, 1],
      ["o", 1, 1],
      ["x", 0, 2],
    ]);
    expect(connectNGame.isComplete(ctx(["x", "o"]), state)).toBe(true);
    const outcome = connectNGame.resolve(ctx(["x", "o"]), state).outcome;
    expect(outcome.winnerUserId).toBe("x");
    expect(outcome.draw).toBe(false);
  });

  test("a full board with no line is a draw", () => {
    const state = play(["x", "o"], ttt, [
      ["x", 0, 0],
      ["o", 0, 1],
      ["x", 0, 2],
      ["o", 1, 1],
      ["x", 1, 0],
      ["o", 1, 2],
      ["x", 2, 1],
      ["o", 2, 0],
      ["x", 2, 2],
    ]);
    expect(connectNGame.isComplete(ctx(["x", "o"]), state)).toBe(true);
    expect(connectNGame.resolve(ctx(["x", "o"]), state).outcome.draw).toBe(true);
  });

  test("redact exposes whose turn it is and the shared board", () => {
    const state = play(["x", "o"], ttt, [["x", 0, 0] as [string, number, number]]);
    const view = connectNGame.redact(ctx(["x", "o"]), state, "o", false) as {
      turn: string;
      yourTurn: boolean;
      game: { board: unknown };
    };
    expect(view.turn).toBe("o");
    expect(view.yourTurn).toBe(true);
    expect(view.game.board).toBeDefined();
  });
});
