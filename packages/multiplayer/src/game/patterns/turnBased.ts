import { z } from "zod";
import { MultiplayerInvalidTransitionError } from "../../error/errors";
import type { WalletEffect } from "../effects";
import type { GameContext, GameModel, ModelOutcome, ResolveResult } from "../model";

/**
 * The **turn-based** pattern — the base helper for games where players act one at a time, in order, against
 * a shared state. Tic-tac-toe, Connect Four, chess, checkers, a card game's tricks.
 *
 * The helper owns turn order and advancement: it tracks whose turn it is, rejects a move out of turn, and
 * rotates to the next player after each move. A game built on it supplies only the game-specific parts — the
 * shared state, how a move changes it, when the game ends, and who won. The turn plumbing is not the game's
 * to write.
 */
export interface TurnBasedSpec<Config, Game, Move> {
  /** The game's `kind` — its registry key. */
  kind: string;
  /** The game's config schema (the `rules` block). */
  config: z.ZodType<Config>;
  /** The schema for the game-specific shared state (turn tracking is the helper's, not this). */
  game: z.ZodType<Game>;
  /** The schema for one move (the body of a player's action). */
  move: z.ZodType<Move>;
  /** The fewest / most players (defaults to 2 / no cap). */
  minPlayers?: number;
  maxPlayers?: number;
  /** The initial game state when play begins. */
  start: (ctx: GameContext<Config>) => Game;
  /** Apply the current player's validated move, returning the next game state (+ optional wallet effects). Throw a `PithyError` on an illegal move. */
  play: (
    ctx: GameContext<Config>,
    game: Game,
    playerId: string,
    move: Move,
  ) => { game: Game; effects?: readonly WalletEffect[] } | Game;
  /** Whether the game has ended (someone won, the board is full…). */
  isEnd: (ctx: GameContext<Config>, game: Game) => boolean;
  /** The outcome once {@link isEnd} holds. */
  score: (ctx: GameContext<Config>, game: Game) => ResolveResult | ModelOutcome;
  /** Optional game-specific view; the helper adds the turn info around it. Defaults to the raw game state. */
  view?: (ctx: GameContext<Config>, game: Game, viewerId: string) => unknown;
}

/** The persisted state of a turn-based game: whose turn (as a roster index) and the game-specific state. */
type TurnBasedState<Game> = { turnIndex: number; game: Game };

/** Build a {@link GameModel} for a turn-based game from its {@link TurnBasedSpec}. */
export function turnBased<Config, Game, Move>(
  spec: TurnBasedSpec<Config, Game, Move>,
): GameModel<Config, TurnBasedState<Game>> {
  const state = z
    .object({
      turnIndex: z.number().int().describe("Index into the roster of whose turn it is."),
      game: spec.game.describe("The game-specific shared state."),
    })
    .describe(`The ${spec.kind} game's state — the turn pointer and the shared position.`);

  return {
    kind: spec.kind,
    config: spec.config,
    state,
    minPlayers: spec.minPlayers,
    maxPlayers: spec.maxPlayers,

    init: (ctx) => ({ turnIndex: 0, game: spec.start(ctx) }),

    apply(ctx, current, playerId, action) {
      if (playerId !== ctx.players[current.turnIndex]) {
        throw new MultiplayerInvalidTransitionError({
          message: "It is not your turn.",
          detail: `${playerId} moved out of turn (turn is ${ctx.players[current.turnIndex]}).`,
        });
      }
      const move = spec.move.parse(action);
      const played = spec.play(ctx, current.game, playerId, move);
      const game = played !== null && typeof played === "object" && "game" in played ? played.game : (played as Game);
      const effects = played !== null && typeof played === "object" && "effects" in played ? played.effects : undefined;
      const turnIndex = (current.turnIndex + 1) % ctx.players.length;
      return { state: { turnIndex, game }, effects };
    },

    isComplete: (ctx, current) => spec.isEnd(ctx, current.game),

    resolve(ctx, current) {
      const result = spec.score(ctx, current.game);
      return "outcome" in result ? result : { outcome: result };
    },

    redact(ctx, current, viewerId) {
      const turn = ctx.players[current.turnIndex] ?? null;
      return {
        turn,
        yourTurn: turn === viewerId,
        ...(spec.view ? { game: spec.view(ctx, current.game, viewerId) } : { game: current.game }),
      };
    },
  };
}
