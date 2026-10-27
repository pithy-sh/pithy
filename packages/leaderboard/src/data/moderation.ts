// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The moderation history — the row in `pithy_leaderboard_moderations` (#817).
 *
 * One row per management act, written in the same `d1.batch()` as the change it records, so a row exists
 * exactly when the change does. It is two things at once:
 *
 * - **The entry's history.** A correction keeps the original score here, beside the reason, so the board
 *   can answer what a score was before somebody changed it.
 * - **The idempotency record.** `idempotencyKey` is unique, so a replayed act finds its row and answers
 *   from it: nothing written twice, nothing emitted twice.
 */

/** Every act a management client may take on a board. */
export const LeaderboardModerationAct = z
  .enum(["hide", "unhide", "correct", "clear_lock"])
  .describe(
    "What the management client did: `hide` or `unhide` an entry, `correct` its score, or `clear_lock` to release a stale rank-refresh lock.",
  );
export type LeaderboardModerationAct = z.infer<typeof LeaderboardModerationAct>;

/** An entry's moderated state, before or after an act. */
export const EntryModerationState = z
  .object({
    kind: z.literal("entry").describe("An entry's state."),
    score: z.number().describe("The entry's score."),
    visible: z.boolean().describe("Whether the player consents to appear."),
    hidden: z.boolean().describe("Whether a moderator has hidden the entry."),
  })
  .describe("An entry's moderated state.");
export type EntryModerationState = z.infer<typeof EntryModerationState>;

/** A lock's state, before an act clears it. */
export const LockModerationState = z
  .object({
    kind: z.literal("lock").describe("A lock's state."),
    holder: z.string().describe("The token of the instance that held the lock."),
    acquiredAt: z.iso.datetime().describe("When that holder took the lock, ISO-8601."),
  })
  .describe("A rank-refresh lock's state.");
export type LockModerationState = z.infer<typeof LockModerationState>;

/** Either state. Discriminated on `kind`, so a row reads back as the shape it was written in. */
export const ModerationState = z
  .discriminatedUnion("kind", [EntryModerationState, LockModerationState])
  .describe("The state an act found or left: an entry's, or a lock's.");
export type ModerationState = z.infer<typeof ModerationState>;

export const LeaderboardModeration = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only."),
    idempotencyKey: z
      .string()
      .describe("The management client's idempotency key. Unique: a replay with the same key changes nothing."),
    act: LeaderboardModerationAct.describe("What was done."),
    boardId: z.string().nullish().describe("The board the act addressed; null for a lock."),
    windowKey: z.string().nullish().describe("The window the act addressed; null for a lock."),
    userId: z.string().nullish().describe("The player whose entry the act addressed; null for a lock."),
    lockName: z.string().nullish().describe("The lock a `clear_lock` released; null for an entry act."),
    reason: z.string().describe("Why, in the operator's words. Required on every act."),
    before: sqliteJson(ModerationState).describe("What the act found."),
    after: sqliteJson(ModerationState)
      .nullish()
      .describe("What the act left; null once a lock is cleared, because nothing is left."),
    changed: SQLiteBoolean.describe(
      "False when the act found the entry already where it asked to put it. Recorded anyway, so a replay of the key still answers the same.",
    ),
    connectionId: z.string().describe("The control-plane connection the act came through."),
    actorId: z.string().describe("The subject the management client named on its token: who pressed the button."),
    createdAt: SQLiteDate.describe("When the act was taken."),
  })
  .describe("One management act on a board, and the idempotency record behind it.");
export type LeaderboardModeration = z.output<typeof LeaderboardModeration>;
export type LeaderboardModerationRow = z.input<typeof LeaderboardModeration>;
