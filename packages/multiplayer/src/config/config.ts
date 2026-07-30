// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MultiplayerGameNotFoundError, MultiplayerInvalidMoveError } from "../error/errors";
import { type GameModel, playerBounds, registeredKinds, resolveModel } from "../game/model";

/**
 * The multiplayer capability's config — the thin, user-owned surface in `pithy.config.ts`. Every field is
 * `.describe()`d: the descriptions feed the self-documenting CLI (CLAUDE.md §Config).
 *
 * A game is generic. It names a **model** by `kind` — one of the two fundamental turn-based shapes,
 * `commit-reveal` (simultaneous, hidden) or `sequential` (turn-order, shared state), or a model an adopter
 * registered — and carries that model's own `rules` block. The session infrastructure (membership,
 * lifecycle, hidden state, alarms, the durable result, the leaderboard publish) is the same for every game;
 * only the `rules` and the model behind them differ. That is the whole point: the package is authoritative
 * turn-based *sessions*, and the game models are pluggable.
 */

/** A game key is a URL path segment (`/multiplayer/games/<key>`), so it is kebab-case and lowercase. */
const GAME_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const MultiplayerLeaderboard = z
  .object({
    board: z
      .string()
      .min(1)
      .describe(
        "The `@pithy-sh/leaderboard` board key a resolved session publishes to. Must match a board configured in the leaderboard capability, and the leaderboard capability must be installed — publishing is one-way, so multiplayer depends on leaderboard, never the reverse.",
      ),
    window: z
      .string()
      .optional()
      .describe(
        "A UTC CRON expression for the board's window (`0 0 * * *` daily), matching the leaderboard board's own `window`. Omit for an all-time board. Publishing writes into the window open at resolution time.",
      ),
    direction: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe("The board's sort direction, matching the leaderboard board — `desc` = highest points win."),
    aggregation: z
      .enum(["best", "latest", "sum"])
      .default("sum")
      .describe(
        "How the board folds repeat results, matching the leaderboard board. `sum` accumulates points across sessions.",
      ),
    points: z
      .object({
        win: z.number().describe("Points the winner is awarded."),
        draw: z.number().describe("Points each player is awarded on a draw."),
        loss: z.number().describe("Points a non-winner is awarded — often 0, but a participation point is fine."),
      })
      .describe("The points each outcome awards, folded into the board by its aggregation."),
  })
  .describe("Optional one-way publish of a session's result to a leaderboard board.");
export type MultiplayerLeaderboard = z.output<typeof MultiplayerLeaderboard>;

export const MultiplayerGame = z
  .object({
    key: z
      .string()
      .regex(GAME_KEY_PATTERN, "A game key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe(
        "The game's stable id, unique across the app. It is a URL path segment and the session's game reference.",
      ),
    kind: z
      .string()
      .min(1)
      .describe(
        "Which game to run: a built-in example (`battle` — simultaneous secret moves; `connect-n` — turn-based grid, i.e. tic-tac-toe/Connect Four/gomoku; `craps` — a wagering table) or a game registered with `registerGameModel`. The three built-ins are built on reusable pattern helpers (`simultaneous`, `turnBased`, `wageringTable`) that you can layer your own game on.",
      ),
    mode: z
      .enum(["match", "table"])
      .default("match")
      .describe(
        "The session lifecycle. `match` (default): a fixed roster fills, plays one game to a result, and ends — a duel, a hand of a card game. `table`: a long-lived session that runs many rounds; players join and leave *between* rounds (a buy-in, a cash-out), the model settles each round, and the table stays open until it is closed or empty — a poker or craps table.",
      ),
    players: z
      .number()
      .int()
      .min(2)
      .default(2)
      .describe(
        "In `match` mode, exactly how many players a session needs before play begins (default 2). In `table` mode, the maximum number of seats. The chosen model constrains the range.",
      ),
    turnTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .optional()
      .describe(
        "How long, in ms, players have to act once play begins before the session is abandoned. Enforced by a Durable Object alarm — never a timer, which would forfeit hibernation. Omit to let a session wait indefinitely (it hibernates and costs nothing while it waits).",
      ),
    leaderboard: MultiplayerLeaderboard.optional().describe(
      "If set, a resolved session publishes its result to this leaderboard board. Requires `@pithy-sh/leaderboard`.",
    ),
    rules: z
      .unknown()
      .describe(
        "The model-specific rules block. Its shape is defined by the game's `kind` and validated against that model's schema at assembly (a `commit-reveal` game's move catalog, a `sequential` game's board size, …). Fails on deploy, not on the first move.",
      ),
  })
  .describe("One game definition — a model reference (`kind`), a roster size, and that model's `rules` block.");
export type MultiplayerGame = z.output<typeof MultiplayerGame>;

export const MultiplayerConfig = z
  .object({
    games: z
      .array(MultiplayerGame)
      .min(1, "A multiplayer capability with no games does nothing — configure at least one.")
      .describe("Every game this app runs. Games are config, not database rows."),
  })
  .describe("Configuration for the multiplayer capability — the game set, each naming a pluggable game model.")
  .check((ctx) => {
    const keys = ctx.value.games.map((g) => g.key);
    const duplicates = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
    if (duplicates.length > 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["games"],
        message: `Duplicate game keys: ${duplicates.join(", ")}. Two games sharing a key would collide.`,
      });
    }
  });
export type MultiplayerConfig = z.output<typeof MultiplayerConfig>;
export type MultiplayerConfigInput = z.input<typeof MultiplayerConfig>;

/** A game with its `rules` validated against its model — the shape the DO and routes carry. */
export interface ResolvedGame extends Omit<MultiplayerGame, "rules"> {
  /** The model-specific rules, parsed by the model's schema. */
  rules: unknown;
}

/**
 * Validate every game against its model: the `kind` must resolve to a registered model, the roster size
 * must fall within the model's player bounds, and the `rules` block must parse against the model's schema.
 * Runs once at assembly (the capability factory), so a typo or an out-of-range roster fails on deploy, not
 * on the first session. Returns the games with their `rules` parsed.
 */
export function validateGames(config: MultiplayerConfig): ResolvedGame[] {
  return config.games.map((game) => {
    const model = resolveModel(game.kind);
    if (!model) {
      throw new MultiplayerGameNotFoundError({
        message: `Game "${game.key}" uses unknown model "${game.kind}".`,
        action: `Use one of: ${registeredKinds().join(", ") || "(none registered)"}, or register a model with registerGameModel().`,
        detail: `No game model registered for kind "${game.kind}".`,
      });
    }
    assertPlayerCount(game, model);
    const rules = parseRules(game, model);
    return { ...game, rules };
  });
}

/** The roster size must fall within the model's supported range. */
function assertPlayerCount(game: MultiplayerGame, model: GameModel): void {
  const { min, max } = playerBounds(model);
  if (game.players < min || game.players > max) {
    const upper = max === Number.POSITIVE_INFINITY ? "" : `–${max}`;
    throw new MultiplayerInvalidMoveError({
      message: `Game "${game.key}" sets ${game.players} players, but "${model.kind}" supports ${min}${upper}.`,
      detail: `Model "${model.kind}" player bounds [${min}, ${max}] exclude ${game.players}.`,
    });
  }
}

/** Parse the `rules` block against the model's schema, surfacing a Zod failure as a config error. */
function parseRules(game: MultiplayerGame, model: GameModel): unknown {
  const parsed = model.config.safeParse(game.rules);
  if (!parsed.success) {
    throw new MultiplayerInvalidMoveError({
      message: `Game "${game.key}" has invalid rules for model "${model.kind}".`,
      action: "Fix the game's `rules` block in pithy.config.ts.",
      detail: `Rules failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
    });
  }
  return parsed.data;
}

/** The game with this key, or undefined. Game keys come from config, so an unknown key is a 404. */
export function resolveGame(games: readonly ResolvedGame[], key: string): ResolvedGame | undefined {
  return games.find((game) => game.key === key);
}
