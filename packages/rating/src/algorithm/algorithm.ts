// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";

/**
 * The rating-algorithm seam — the one contract that keeps the tracker's storage, config, and HTTP
 * surface generic while the *math* of turning a game's result into new numbers stays pluggable.
 *
 * It is the deliberate mirror of `@pithy-sh/multiplayer`'s game-model registry (`game/model.ts`): a
 * `RatingAlgorithm` is looked up by `id` from a {@link registerRatingAlgorithm registry}, it declares the
 * player counts it supports, and the config layer rejects at assembly a game that wires a 1v1-only
 * algorithm (`elo`/`glicko`) to an N-player game — the same shape as multiplayer's `validateGames`.
 *
 * Three built-ins ship (`elo`, `glicko`, `trueskill`); an adopter registers their own the same way. The
 * seam is code, not data: an algorithm's logic is imported into the worker bundle, while only its per-
 * player {@link RatingAlgorithm.state state} (a serializable, Zod-validated blob) lives in D1.
 */

/** One player's entry into a rated result: who they are and their rating state *before* the game. */
export interface RatingEntry<State = unknown> {
  /** The player's authenticated user id (the `pithy_auth_users.id` UUID from `AuthContext`). */
  playerId: string;
  /** The player's current rating state in the game's pool — {@link RatingAlgorithm.initial} for a newcomer. */
  state: State;
}

/**
 * The result of one rated game, in the model-neutral shape every algorithm consumes. Placement is a
 * finishing place per player: `1` is the winner, ties share a place. For a 1v1 win, the winner is place
 * `1` and the loser place `2`; a draw makes both place `1`. Free-for-all and team formats express their
 * full ordering the same way.
 */
export interface RatedOutcome {
  /** Each player's finishing place (1-based). Equal values are a tie. Every entered player must appear. */
  ranks: Record<string, number>;
  /**
   * Optional team grouping: player id → team id. Present only for a team format (TrueSkill), where a
   * team's players share a placement and the update pools their skill. Absent for 1v1 / free-for-all.
   */
  teams?: Record<string, string>;
}

/**
 * One rating algorithm — a pluggable implementation of "given everyone's state and how the game finished,
 * what is everyone's new state?" `State` is the per-player blob persisted between games; `Params` is the
 * algorithm's declarative tuning (K-factor, volatility constraint, prior μ/σ), validated at assembly and
 * threaded into every call — the exact analog of a multiplayer model's `rules` block.
 */
export interface RatingAlgorithm<State = unknown, Params = unknown> {
  /** The discriminator that matches a game config's `algorithm`. Unique per registered algorithm. */
  id: string;
  /** Validates and types the algorithm's tuning block (`algoParams` in config). Must supply defaults. */
  params: z.ZodType<Params>;
  /** Validates and types the persisted per-player state — round-tripped through D1 on every read. */
  state: z.ZodType<State>;
  /** The fewest players a single rated game supports. `elo`/`glicko` = 2; `trueskill` = 2. */
  minPlayers: number;
  /** The most players a single rated game supports. `elo`/`glicko` = 2; `trueskill` = `Infinity`. */
  maxPlayers: number;
  /** Whether the algorithm can rate team formats (a `teams` grouping). Only `trueskill`. */
  supportsTeams: boolean;
  /** A brand-new player's starting state, from the (defaulted) params. */
  initial(params: Params): State;
  /**
   * Recompute every participant's state from one game's outcome. Pure — no clock, no storage, no RNG.
   * Returns the new state for every entered player, keyed by `playerId`; the caller persists each.
   */
  update(params: Params, entries: readonly RatingEntry<State>[], outcome: RatedOutcome): Record<string, State>;
  /**
   * The single comparable number the API exposes and matchmaking buckets on. Conservative where the
   * algorithm models uncertainty: `elo` = rating; `glicko` = rating − 2·RD; `trueskill` = μ − 3·σ.
   */
  skill(params: Params, state: State): number;
}
