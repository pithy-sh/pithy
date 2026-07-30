// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MultiplayerLeaderboard } from "../config/config";
import { RngState } from "../game/random";

/**
 * A session's lifecycle phase — game-agnostic. `open` and `active` are live; `resolved` and `abandoned` are
 * terminal and never transition again.
 *
 *   open      → created, waiting for the roster to fill.
 *   active    → the roster is full and play is underway (players committing, or taking turns).
 *   resolved  → the game reached a terminal position and the server computed a result. Terminal.
 *   abandoned → the action deadline passed with the game unfinished. Terminal.
 */
export const SessionPhase = z
  .enum(["open", "active", "resolved", "abandoned"])
  .describe("The session's lifecycle phase. `open`/`active` are live; `resolved`/`abandoned` are terminal.");
export type SessionPhase = z.infer<typeof SessionPhase>;

/** True when a phase is terminal — no further transitions are allowed from it. */
export function isTerminal(phase: SessionPhase): boolean {
  return phase === "resolved" || phase === "abandoned";
}

/**
 * A snapshot of a game's resolved config, taken at session creation and stored in the DO. The session
 * resolves against this snapshot and never reads live app config again, so a later config edit cannot
 * change a session already in flight. `rules` is the model-specific block, kept opaque here (the game's
 * model validates and interprets it) — the session infrastructure treats every game the same.
 */
export const GameSnapshot = z
  .object({
    key: z.string().describe("The game key this session plays."),
    kind: z.string().describe("The game model's `kind` — the DO resolves the model from the registry by this."),
    mode: z
      .enum(["match", "table"])
      .describe("`match` (fill → one game → end) or `table` (long-lived, many rounds, join/leave between)."),
    players: z.number().int().describe("Match mode: the exact roster. Table mode: the maximum seats."),
    turnTimeoutMs: z.number().int().nullable().describe("The commit/turn deadline in ms, or null for no deadline."),
    leaderboard: MultiplayerLeaderboard.nullable().describe("The leaderboard publish target, or null."),
    rules: z
      .unknown()
      .describe("The model-specific rules block — interpreted by the game's model, opaque to the session."),
  })
  .describe("A snapshot of a game's resolved config, stored in the session's Durable Object.");
export type GameSnapshot = z.infer<typeof GameSnapshot>;

/**
 * A session's authoritative metadata, persisted in the Durable Object's own storage — the single source of
 * truth, read fresh on each request (the DO holds nothing important in memory). Game-specific state lives
 * separately under the model's own storage key.
 */
export const SessionMeta = z
  .object({
    sessionId: z.string().describe("The Durable Object id (hex) this session is addressed by."),
    game: GameSnapshot.describe("The game's config snapshot — model, roster size, rules, deadline, leaderboard."),
    phase: SessionPhase.describe("The session's current lifecycle phase."),
    members: z
      .array(z.string())
      .describe("The authenticated user ids of the players, in join order. Never client-asserted."),
    createdAt: z.number().int().describe("When the session was created, ms-epoch."),
    deadline: z
      .number()
      .int()
      .nullable()
      .describe(
        "The action deadline as an absolute ms-epoch time, or null when the session waits indefinitely. Enforced by the DO alarm.",
      ),
    rng: RngState.describe(
      "The session's provably-fair RNG — the seed models draw from, its commitment, and the stream position.",
    ),
  })
  .describe("A session's authoritative metadata, persisted in Durable Object storage.");
export type SessionMeta = z.infer<typeof SessionMeta>;

/** The resolved outcome persisted alongside a terminal session (mirrors the D1 result row's payload). */
export const SessionOutcome = z
  .object({
    status: z.enum(["resolved", "abandoned"]).describe("The terminal state."),
    scores: z.record(z.string(), z.number()).nullable().describe("Each player's score, or null when abandoned."),
    winnerUserId: z.string().nullable().describe("The winner's user id, or null on a draw or abandonment."),
    draw: z.boolean().describe("Whether the session ended level."),
    resolvedAt: z.number().int().describe("When the session reached its terminal state, ms-epoch."),
  })
  .describe("The resolved outcome of a terminal session.");
export type SessionOutcome = z.infer<typeof SessionOutcome>;

/**
 * What one player sees of a session — the game-agnostic envelope. The session fields (phase, players,
 * outcome) are the same for every game; `state` is the model-specific view the game's `redact` produced for
 * this viewer, and it is where hidden state is enforced (an opponent's secret is absent until the reveal).
 */
export const SessionView = z
  .object({
    sessionId: z.string().describe("The session id."),
    gameKey: z.string().describe("The game being played."),
    kind: z.string().describe("The game model this session uses."),
    phase: SessionPhase.describe("The session's current phase."),
    players: z.array(z.string()).describe("Every member's user id, in join order."),
    outcome: SessionOutcome.nullable().describe("The result, present only once the session is terminal."),
    state: z.unknown().describe("The model-specific view for this viewer, redacted by the game's model."),
    fairness: z
      .object({
        seedHash: z
          .string()
          .describe("The RNG seed's SHA-256 commitment — shown from the start, so a player can verify fairness later."),
        seed: z
          .string()
          .nullable()
          .describe("The RNG seed itself — null until the session is terminal, then revealed to verify every draw."),
      })
      .describe("The provably-fair commitment (and, once terminal, the reveal) for this session's randomness."),
  })
  .describe("One player's view of a session — the game-agnostic envelope around a model-specific, redacted state.");
export type SessionView = z.infer<typeof SessionView>;
