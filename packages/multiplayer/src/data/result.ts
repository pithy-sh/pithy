// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The set of terminal states a session's result row records. A session ends resolved or abandoned. */
export const SessionResultStatus = z
  .enum(["resolved", "abandoned"])
  .describe(
    "The terminal state this result records: `resolved` (a winner or draw) or `abandoned` (timed out or quit).",
  );
export type SessionResultStatus = z.infer<typeof SessionResultStatus>;

/** What one consumer of a void did, as the result row keeps it: its name and its status, never its report. */
export const VoidConsumerStatus = z
  .object({
    consumer: z.string().describe("The composed capability the void called: `leaderboard` or `rating`."),
    status: z
      .enum(["pending", "done", "failed"])
      .describe(
        "`done` when the consumer took the result back, `failed` when it threw or could not be called, and `pending` while the void that called it is still running — or if it stopped before the consumer answered.",
      ),
    error: z
      .object({
        code: z.string().describe("The failure's error code."),
        message: z.string().describe("The failure's public message."),
      })
      .nullable()
      .describe("Why the consumer failed, or null when it did not."),
  })
  .describe("One consumer's part in a void, as the result row records it.");
export type VoidConsumerStatus = z.infer<typeof VoidConsumerStatus>;

/**
 * One session's durable result — the row in `pithy_multiplayer_results`. Written exactly once, when a
 * session reaches a terminal state; the session's authority lives in its Durable Object, but the *record*
 * of what happened outlives the object here in D1, joinable against the adopter's own tables.
 *
 * `z.output` is the app shape (Dates, booleans, parsed JSON); `z.input` is the SQLite row (ms-epoch, 0|1,
 * JSON strings). All JS↔SQLite conversion runs through the core codecs (CLAUDE.md §Data layer) — no raw
 * `0/1`, epoch, `new Date()`, or `JSON.stringify` in query code.
 *
 * `sessionId` is the Durable Object id (hex), unique per session, and the natural key a result is
 * addressed by — `id` is an internal autoincrement never exposed.
 */
export const MultiplayerResult = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only; results are addressed by sessionId."),
    sessionId: z.string().describe("The Durable Object id (hex) of the session this result belongs to. Unique."),
    gameKey: z.string().describe("The game this session played, from `games` in pithy.config.ts."),
    status: SessionResultStatus.describe("The terminal state — resolved or abandoned."),
    players: sqliteJson(z.array(z.string())).describe(
      "The authenticated user ids of the session's members, in join order.",
    ),
    scores: sqliteJson(z.record(z.string(), z.number()))
      .nullable()
      .describe("Each player's final score, keyed by user id. Null on an abandoned session, which is never scored."),
    winnerUserId: z
      .string()
      .nullable()
      .describe("The winning player's user id. Null on a draw, and null on an abandoned session."),
    draw: SQLiteBoolean.describe("Whether the session ended level. False on an abandoned session."),
    createdAt: SQLiteDate.describe("When the session was created."),
    resolvedAt: SQLiteDate.describe("When the session reached its terminal state and this row was written."),
    voidedAt: SQLiteDate.nullable().describe("When a management client voided the result, or null while it counts."),
    voidKey: z
      .string()
      .nullable()
      .describe(
        "The idempotency key that last took the void — the void's own, or a retry's — or null. Every key ever spent is in `pithy_multiplayer_void_keys`.",
      ),
    voidConsumers: sqliteJson(z.array(VoidConsumerStatus))
      .nullable()
      .describe("What each composed consumer did with the void, or null before one. Never a consumer's report."),
  })
  .describe("One session's durable result — the row in `pithy_multiplayer_results`.");
export type MultiplayerResult = z.output<typeof MultiplayerResult>;
export type MultiplayerResultRow = z.input<typeof MultiplayerResult>;

/** A result as a terminal session writes it: everything but the void, which only a management client sets. */
export type NewMultiplayerResult = Omit<MultiplayerResult, "voidedAt" | "voidKey" | "voidConsumers">;
