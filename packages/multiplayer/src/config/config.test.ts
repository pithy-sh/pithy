import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import "../game/builtins";
import { MultiplayerConfig, type MultiplayerConfigInput, resolveGame, validateGames } from "./config";

/** A commit-reveal game as it appears in pithy.config.ts. */
const battle = (over: Partial<MultiplayerConfigInput["games"][number]> = {}) => ({
  key: "battle",
  kind: "battle" as const,
  rules: {
    offense: { pick: 1, moves: [{ name: "fire", power: 10 }] },
    defense: { pick: 1, moves: [{ name: "guard-fire", blocks: "fire" }] },
  },
  ...over,
});

/** A sequential grid game (tic-tac-toe). */
const tictactoe = (over: Partial<MultiplayerConfigInput["games"][number]> = {}) => ({
  key: "tictactoe",
  kind: "connect-n" as const,
  rules: { rows: 3, cols: 3, connect: 3 },
  ...over,
});

const parse = (games: MultiplayerConfigInput["games"]) => MultiplayerConfig.safeParse({ games });

describe("MultiplayerConfig", () => {
  test("parses a game set of mixed models and defaults players to 2", () => {
    const result = MultiplayerConfig.parse({ games: [battle(), tictactoe()] });
    expect(result.games).toHaveLength(2);
    expect(result.games[0]?.players).toBe(2);
  });

  test("rejects an empty game set and duplicate keys and a non-kebab key", () => {
    expect(parse([]).success).toBe(false);
    expect(parse([battle(), battle()]).success).toBe(false);
    expect(parse([battle({ key: "Battle Royale" })]).success).toBe(false);
  });
});

describe("validateGames", () => {
  test("validates a commit-reveal and a sequential game and parses their rules", () => {
    const games = validateGames(MultiplayerConfig.parse({ games: [battle(), tictactoe()] }));
    expect(games.map((g) => g.kind)).toEqual(["battle", "connect-n"]);
    expect(resolveGame(games, "tictactoe")?.rules).toMatchObject({ rows: 3, cols: 3, connect: 3 });
  });

  test("rejects an unknown model kind", () => {
    const config = MultiplayerConfig.parse({ games: [battle({ kind: "chess" })] });
    try {
      validateGames(config);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("multiplayer/game_not_found");
    }
  });

  test("rejects rules that don't match the model", () => {
    // A sequential game with a connect longer than the board.
    const config = MultiplayerConfig.parse({ games: [tictactoe({ rules: { rows: 3, cols: 3, connect: 5 } })] });
    expect(() => validateGames(config)).toThrow(/invalid rules/);
  });

  test("rejects a roster below the model's minimum", () => {
    const config = MultiplayerConfig.parse({ games: [battle({ players: 2 })] });
    expect(validateGames(config)).toHaveLength(1); // 2 is fine
    // Player count is validated at min 2 by the schema, and against the model bounds by validateGames.
    expect(MultiplayerConfig.safeParse({ games: [battle({ players: 1 })] }).success).toBe(false);
  });

  test("allows N players for a commit-reveal free-for-all", () => {
    const games = validateGames(MultiplayerConfig.parse({ games: [battle({ players: 4 })] }));
    expect(games[0]?.players).toBe(4);
  });
});

describe("resolveGame", () => {
  test("finds a configured game and misses an unknown key", () => {
    const games = validateGames(MultiplayerConfig.parse({ games: [battle()] }));
    expect(resolveGame(games, "battle")?.key).toBe("battle");
    expect(resolveGame(games, "nope")).toBeUndefined();
  });
});
