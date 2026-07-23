import { z } from "zod";
import { MultiplayerInvalidMoveError } from "../../error/errors";
import type { ModelOutcome } from "../model";
import { turnBased } from "../patterns/turnBased";

/**
 * Connect-N — the flagship **turn-based** game (built on the {@link turnBased} pattern).
 *
 * Players take turns claiming empty cells; the first to line up `connect` cells in a row — horizontal,
 * vertical, or diagonal — wins. It is a whole family in one config: tic-tac-toe is `3×3 connect 3`, Connect
 * Four is `7×6 connect 4`, gomoku is `15×15 connect 5`. The whole game is a config plus how a move changes
 * the board and how a win is detected; the turn order and advancement come from the pattern.
 */

export const ConnectNConfig = z
  .object({
    rows: z.number().int().min(1).describe("Board height in cells."),
    cols: z.number().int().min(1).describe("Board width in cells."),
    connect: z
      .number()
      .int()
      .min(2)
      .describe("How many of a player's cells in a line (row, column, or diagonal) wins."),
  })
  .describe("The connect-n game's rules — board size and the line length that wins.")
  .check((ctx) => {
    const { rows, cols, connect } = ctx.value;
    if (connect > Math.max(rows, cols))
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["connect"],
        message: `connect ${connect} is longer than the board's ${Math.max(rows, cols)} — no line could ever win.`,
      });
  });
export type ConnectNConfig = z.output<typeof ConnectNConfig>;

/** The board state (turn tracking is the turn-based pattern's, not here). */
export const BoardState = z
  .object({
    board: z
      .array(z.array(z.string().nullable()))
      .describe("Row-major grid; each cell is the user id that claimed it, or null."),
    moves: z.number().int().describe("How many cells have been claimed — the board is full at rows×cols."),
  })
  .describe("The connect-n board.");
export type BoardState = z.infer<typeof BoardState>;

/** One move: the cell to claim. */
export const GridMove = z
  .object({
    row: z.number().int().describe("The 0-indexed row of the cell to claim."),
    col: z.number().int().describe("The 0-indexed column of the cell to claim."),
  })
  .describe("A connect-n move — the cell a player claims on their turn.");
export type GridMove = z.infer<typeof GridMove>;

/** The user id who owns a winning line of `connect`, or null. Scans right, down, and both diagonals. */
export function findWinner(board: (string | null)[][], connect: number): string | null {
  const rows = board.length;
  const cols = board[0]?.length ?? 0;
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const owner = board[r]?.[c];
      if (!owner) continue;
      for (const [dr, dc] of directions) {
        let run = 1;
        while (run < connect && board[r + dr * run]?.[c + dc * run] === owner) run++;
        if (run >= connect) return owner;
      }
    }
  }
  return null;
}

export const connectNGame = turnBased<ConnectNConfig, BoardState, GridMove>({
  kind: "connect-n",
  config: ConnectNConfig,
  game: BoardState,
  move: GridMove,
  minPlayers: 2,

  start: (ctx) => ({
    board: Array.from({ length: ctx.config.rows }, () =>
      Array.from({ length: ctx.config.cols }, () => null as string | null),
    ),
    moves: 0,
  }),

  play(ctx, state, playerId, move) {
    const { row, col } = move;
    if (row < 0 || row >= ctx.config.rows || col < 0 || col >= ctx.config.cols) {
      throw new MultiplayerInvalidMoveError({
        message: "That cell is off the board.",
        detail: `(${row}, ${col}) outside ${ctx.config.rows}×${ctx.config.cols}.`,
      });
    }
    if (state.board[row]?.[col]) {
      throw new MultiplayerInvalidMoveError({
        message: "That cell is already taken.",
        detail: `(${row}, ${col}) is claimed by ${state.board[row]?.[col]}.`,
      });
    }
    const board = state.board.map((r) => [...r]);
    (board[row] as (string | null)[])[col] = playerId;
    return { game: { board, moves: state.moves + 1 } };
  },

  isEnd: (ctx, state) =>
    findWinner(state.board, ctx.config.connect) !== null || state.moves >= ctx.config.rows * ctx.config.cols,

  score(ctx, state): ModelOutcome {
    const winner = findWinner(state.board, ctx.config.connect);
    const scores: Record<string, number> = {};
    for (const player of ctx.players) scores[player] = player === winner ? 1 : 0;
    return { scores, winnerUserId: winner, draw: winner === null };
  },
});
