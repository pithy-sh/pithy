// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { LedgerEffect } from "./effects";
import type { RandomSource } from "./random";

/**
 * The game-model seam — the one contract that keeps the session infrastructure generic.
 *
 * A `MultiplayerSession` Durable Object knows nothing about any particular game: membership, the lifecycle,
 * hidden state, the alarm-driven deadline, the durable D1 result, the leaderboard publish, and the CLI DO
 * wiring are all game-agnostic. Everything a specific game *is* — how a move validates, how state advances,
 * when it ends, who wins, and what each player is allowed to see — lives behind a {@link GameModel}, looked
 * up by `kind` from the {@link resolveModel registry}. The two built-ins ({@link commitRevealModel} and
 * {@link sequentialModel}) are the two fundamental turn-based shapes — simultaneous and sequential — and an
 * adopter registers their own with {@link registerGameModel}.
 *
 * The seam is code, not data: a model's *logic* is imported into the worker bundle, while only its *state*
 * (a serializable, Zod-validated blob) lives in DO storage. That is what lets the DO — which is constructed
 * by the runtime and cannot be handed a closure — delegate to a model it never imported directly.
 */

/** The resolved result of a game, in the model-neutral shape the session records and publishes. */
export interface ModelOutcome {
  /** Each player's final score, keyed by user id. */
  scores: Record<string, number>;
  /** The winning player's user id, or null on a draw. */
  winnerUserId: string | null;
  /** Whether the game ended level. */
  draw: boolean;
}

/** What `apply` returns: the next state, and any ledger effects the DO should settle (a bet's hold). */
export interface ApplyResult<State> {
  /** The next game state. */
  state: State;
  /** Ledger operations this transition implies — placed a bet, settled a round. Omit for a game with no wagering. */
  effects?: readonly LedgerEffect[];
}

/** Wrap a bare next-state as an {@link ApplyResult} — the shape a non-wagering model returns. */
export function nextState<State>(state: State, effects?: readonly LedgerEffect[]): ApplyResult<State> {
  return effects ? { state, effects } : { state };
}

/** What `resolve` returns: the final outcome, and any ledger effects the terminal result implies (payouts). */
export interface ResolveResult {
  /** The final outcome — scores, a winner, or a draw. */
  outcome: ModelOutcome;
  /** Ledger operations the result implies — capture losing stakes, pay the winner. Omit for a game with no wagering. */
  effects?: readonly LedgerEffect[];
}

/** What a model gets on every call: its validated config, the roster in join/turn order, a clock, and RNG. */
export interface GameContext<Config> {
  /** The session's id (the DO id, hex). Use it to build stable, idempotent ledger-effect refs. */
  sessionId: string;
  /** The game's model-specific config (the `rules` block), already validated by {@link GameModel.config}. */
  config: Config;
  /** The session's members, in join order — also the turn order for sequential games. */
  players: readonly string[];
  /** The current time as ms-epoch, supplied by the DO (never read from a clock inside a model). */
  now: number;
  /**
   * Server-authoritative, provably-fair randomness — the seeded stream the DO advances and persists. Draw
   * from it only in `init` and `apply` (the transitions the DO commits); `resolve` and `redact` must stay
   * pure, or a replay would diverge. A model with no chance (tic-tac-toe) simply never touches it.
   */
  random: RandomSource;
}

/**
 * One game model — a pluggable implementation of a game's rules over the shared session lifecycle.
 *
 * `Config` is the model's declarative config (the game's `rules` block); `State` is the authoritative game
 * state the DO persists between actions. Both are Zod-validated: `config` at assembly, `state` on every
 * read from DO storage (defense in depth against a corrupt blob).
 */
export interface GameModel<Config = unknown, State = unknown> {
  /** The discriminator that matches a game config's `kind`. Unique per registered model. */
  kind: string;
  /** Validates and types the game's model-specific `rules` block. */
  config: z.ZodType<Config>;
  /** Validates and types the persisted game state — round-tripped through DO storage. */
  state: z.ZodType<State>;
  /** The fewest players this model supports (roster size). Defaults to 2 when omitted. */
  minPlayers?: number;
  /** The most players this model supports, or undefined for no upper bound. */
  maxPlayers?: number;
  /** The initial game state, built when the roster fills and play begins. */
  init(ctx: GameContext<Config>): State;
  /**
   * Validate and apply one player's action, returning the next state (and any ledger effects it implies —
   * a placed bet's hold, a settled round's payouts). Throws a `PithyError` (`multiplayer/invalid_move` or
   * `multiplayer/invalid_transition`) when the action is illegal. A rejected action — or one whose effects
   * the ledger cannot settle (a hold a player cannot cover) — is never persisted. May return a bare `State`
   * for a game with no wagering.
   */
  apply(ctx: GameContext<Config>, state: State, playerId: string, action: unknown): ApplyResult<State>;
  /** Whether the game has reached a terminal position (all committed, someone won, the board is full…). */
  isComplete(ctx: GameContext<Config>, state: State): boolean;
  /**
   * The outcome once {@link isComplete} holds — scores, a winner, or a draw — and any ledger effects the
   * terminal result implies (final payouts).
   */
  resolve(ctx: GameContext<Config>, state: State): ResolveResult;
  /**
   * The model-specific view one player is allowed to see. This is the hidden-state boundary: redact an
   * opponent's secret information here, and reveal it only when `revealed` is true (the session is
   * terminal). A fully-open game (a visible board) returns the same view to everyone.
   */
  redact(ctx: GameContext<Config>, state: State, viewerId: string, revealed: boolean): unknown;
  /**
   * Table mode only: a player took a seat mid-session. Optional — react to the seating (a buy-in, dealing
   * them in next round) and declare any ledger effects. `ctx.players` already includes the joiner. Omit for
   * a match-mode game, or a table game that needs no per-join bookkeeping.
   */
  onJoin?(ctx: GameContext<Config>, state: State, playerId: string): ApplyResult<State>;
  /**
   * Table mode only: a player left their seat mid-session. Optional — settle them out (release their open
   * holds, cash out) and declare ledger effects. `ctx.players` already excludes the leaver. Omit if leaving
   * needs no bookkeeping.
   */
  onLeave?(ctx: GameContext<Config>, state: State, playerId: string): ApplyResult<State>;
}

/** The registry: game `kind` → its model. Populated with the built-ins and any {@link registerGameModel} adds. */
const registry = new Map<string, GameModel>();

/**
 * Register a game model, making its `kind` resolvable by every session. Called at module load — the worker
 * entry and the DO share one isolate, so a model registered when the worker imports is present by the time
 * the DO handles a request. Re-registering the same `kind` replaces it (last write wins), which is what
 * lets an adopter override a built-in.
 */
export function registerGameModel(model: GameModel): void {
  registry.set(model.kind, model);
}

/** The model for a `kind`, or undefined if none is registered. */
export function resolveModel(kind: string): GameModel | undefined {
  return registry.get(kind);
}

/** Every registered model's `kind`, for config validation and error messages. */
export function registeredKinds(): string[] {
  return [...registry.keys()];
}

/** The fewest / most players a model allows, with the shared default of 2 and no upper bound. */
export function playerBounds(model: GameModel): { min: number; max: number } {
  return { min: model.minPlayers ?? 2, max: model.maxPlayers ?? Number.POSITIVE_INFINITY };
}
