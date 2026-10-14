// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * What a session looks like from outside: its phase, its outcome, and one player's view of it. Its own module,
 * importing nothing but zod, because `http/responses.ts` hands `SessionView` to a browser and the Durable
 * Object state beside it reaches config, the RNG and the Workers runtime. The Durable Object imports these
 * from here too, so there is one definition and the wire shape cannot drift from what the session sends.
 */

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
