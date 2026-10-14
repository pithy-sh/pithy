// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MultiplayerLeaderboard } from "../config/config";
import { RngState } from "../game/random";
import { SessionPhase } from "./view";

// Re-exported, which this kit otherwise never does, because this path is a public address: the folder path
// is the import path, and these were published here before they moved to `./view` so a browser could import
// them without the Durable Object's runtime (#719). Removing the line breaks every import of the old address.
export { SessionOutcome, SessionPhase, SessionView } from "./view";

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

/**
 * What a session socket carries across hibernation, in its attachment: who it belongs to, and the
 * subprotocol it negotiated at the upgrade, so every later frame renders for that version. Tiny, well under
 * the 16,384-byte attachment ceiling. Read back through this schema, never cast.
 */
export const SocketAttachment = z
  .object({
    userId: z.string().describe("The authenticated user id the upgrade was forwarded with."),
    sessionId: z.string().describe("The session the socket is on."),
    protocol: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "The subprotocol negotiated at the upgrade, or null for an unversioned client. A socket accepted before versions existed has none, and reads as null.",
      ),
  })
  .describe("A session socket's hibernation-safe attachment.");
export type SocketAttachment = z.output<typeof SocketAttachment>;
