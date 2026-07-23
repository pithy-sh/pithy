import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The set of terminal states a session's result row records. A session ends resolved or abandoned. */
export const SessionResultStatus = z
  .enum(["resolved", "abandoned"])
  .describe(
    "The terminal state this result records: `resolved` (a winner or draw) or `abandoned` (timed out or quit).",
  );
export type SessionResultStatus = z.infer<typeof SessionResultStatus>;

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
  })
  .describe("One session's durable result — the row in `pithy_multiplayer_results`.");
export type MultiplayerResult = z.output<typeof MultiplayerResult>;
export type MultiplayerResultRow = z.input<typeof MultiplayerResult>;
