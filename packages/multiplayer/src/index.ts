// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add multiplayer` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the game-model seam, and the session shapes
 * an app renders. Every other module is imported by deep path (`@pithy-sh/multiplayer/src/...`); this is the
 * documented contract, not a barrel over the package.
 *
 * **The `MultiplayerSession` Durable Object is deliberately not here.** It imports `cloudflare:workers`,
 * which resolves in workerd and nowhere else, and this module is what an adopter's `pithy.config.ts`
 * imports — a file loaded by every Node-side CLI command. Re-exporting the class from here put the whole
 * Durable Object chain on that path and broke `pithy upgrade` for any project composing multiplayer (#172).
 * The factory and the DO are two things with two runtimes, and this entry point carries only the first.
 *
 * The adopter's worker still exports the class, from its own module:
 *
 * ```ts
 * export { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";
 * ```
 *
 * — which is what the manifest's scaffold step says, and what wrangler's `class_name` resolves against.
 * The CLI writes the binding and the class migration tag for you. To ship a custom game model, call
 * `registerGameModel(myModel)` in the worker entry.
 */

export {
  isMultiplayerCapability,
  MULTIPLAYER_MIGRATION_ORDER,
  MULTIPLAYER_SESSION_CLASS,
  MULTIPLAYER_SESSIONS_BINDING,
  type MultiplayerCapability,
  type MultiplayerOptions,
  multiplayer,
} from "./capability";
export {
  MultiplayerConfig,
  type MultiplayerConfigInput,
  MultiplayerGame,
  MultiplayerLeaderboard,
  type ResolvedGame,
  resolveGame,
  validateGames,
} from "./config/config";
export { MultiplayerResult, SessionResultStatus } from "./data/result";
export { BUILT_IN_GAMES } from "./game/builtins";
export type { LedgerEffect } from "./game/effects";
// Example games, each built on a reusable pattern helper.
export {
  BattleConfig,
  battleGame,
  DefenseMove,
  Move,
  OffenseMove,
  scoreBattle,
  validateMove,
} from "./game/games/battle";
export { BoardState, ConnectNConfig, connectNGame, findWinner, GridMove } from "./game/games/connectN";
export { CrapsBet, CrapsBetType, CrapsConfig, CrapsRound, crapsGame } from "./game/games/craps";
// The game-model seam and its registry — the extension point for custom games.
export {
  type ApplyResult,
  type GameContext,
  type GameModel,
  type ModelOutcome,
  nextState,
  type ResolveResult,
  registeredKinds,
  registerGameModel,
  resolveModel,
} from "./game/model";
// The pattern helpers — layer a new game on one of these.
export { type SimultaneousSpec, simultaneous } from "./game/patterns/simultaneous";
export { type TurnBasedSpec, turnBased } from "./game/patterns/turnBased";
export {
  type BetDecision,
  type PendingBet,
  type WageringTableSpec,
  wageringTable,
} from "./game/patterns/wageringTable";
export { createRngState, type RandomSource, RngState, randomSource } from "./game/random";
export { GameSnapshot, isTerminal, type SessionOutcome, SessionPhase, SessionView } from "./session/state";
