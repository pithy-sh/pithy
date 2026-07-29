/**
 * The package entrypoint — the surface `pithy add multiplayer` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, its config and options types, the game-model seam, and the session shapes
 * an app renders. Every other module is imported by deep path (`@pithy-sh/multiplayer/src/...`); this is the
 * documented contract, not a barrel over the package.
 *
 * The Durable Object class is intentionally re-exported here too: an adopter's worker must
 * `export { MultiplayerSession } from "@pithy-sh/multiplayer/src/index"` (or the deep path) so wrangler's
 * `class_name` resolves against the worker entry — the CLI writes that binding and the class migration tag
 * for you. To ship a custom game model, call `registerGameModel(myModel)` in the worker entry.
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
export { MultiplayerSession, type MultiplayerSessionEnv } from "./session/durableObject";
export { GameSnapshot, isTerminal, type SessionOutcome, SessionPhase, SessionView } from "./session/state";
