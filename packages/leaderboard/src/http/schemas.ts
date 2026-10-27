// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";
import { BOARD_KEY_PATTERN } from "../config/boardKey";
import { MAX_SEGMENT_SIZE } from "../rank/segment";

/**
 * The HTTP boundary shapes. Everything a client can send is parsed through one of these before it
 * reaches a handler — declared on the route line with `zValidator(target, Schema, validationHook)`, so
 * reading a route tells you what it takes.
 *
 * Note what is absent from {@link SubmitScoreBody}: `userId`, `achievedAt`, and `rank`. The player comes
 * from the AuthContext seam, the clock comes from the server, and the rank is derived — a client that
 * could set any of them could score as someone else, backdate its way past the tiebreak, or simply
 * declare itself first. Server-authoritative is not only about who may call submit; it is about which
 * fields a caller may name at all.
 */

/** A player id is opaque to us — it comes from the adopter's auth provider — so it is bounded, not shaped. */
const MAX_USER_ID_LENGTH = 256;

export const BoardParam = z
  .object({
    board: z
      .string()
      .min(1)
      .max(64)
      .regex(BOARD_KEY_PATTERN, "A board key is lowercase, digits, and dashes — it is a URL path segment.")
      .describe(
        "Which board the route addresses. A shape check only: the same pattern config already enforces on every board key, so nothing that resolves today is rejected. Whether the key is *configured* stays the handler's 404.",
      ),
  })
  .describe("The board a `/leaderboard/:board` route addresses.");
export type BoardParam = z.infer<typeof BoardParam>;

export const EntryParam = BoardParam.extend({
  userId: z
    .string()
    .min(1)
    .max(MAX_USER_ID_LENGTH)
    .describe(
      "The player whose entry a moderation route targets. Bounded in length, not in charset — player ids are minted by your auth provider, so we cap what reaches the store rather than guess its format.",
    ),
}).describe("The board and player a moderation route addresses.");
export type EntryParam = z.infer<typeof EntryParam>;

export const SubmitScoreBody = z
  .object({
    score: z
      .number()
      .finite()
      .describe("The score to submit. Folded into the player's entry by the board's aggregation."),
  })
  .describe("A score submission. The player, the window, and the timestamp are all server-derived.");
export type SubmitScoreBody = z.infer<typeof SubmitScoreBody>;

export const WindowQuery = z
  .object({
    window: z
      .string()
      .optional()
      .describe(
        "Which window to read — the ISO key of a closed window, or omit for the one open now. Reading your own history is the point: these windows live in your D1 for as long as `retain` says, which no platform SDK offers.",
      ),
  })
  .describe("Selects the window a read applies to.");
export type WindowQuery = z.infer<typeof WindowQuery>;

export const TopQuery = WindowQuery.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("How many entries to return, capped at 100 — a page, not the whole board."),
  offset: z.coerce.number().int().min(0).default(0).describe("How many entries to skip. Ranks number from here."),
}).describe("A page of a board, best first.");
export type TopQuery = z.infer<typeof TopQuery>;

export const AroundQuery = WindowQuery.extend({
  radius: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(5)
    .describe("How many entries to return either side of the player."),
}).describe("The slice of a board centered on the calling player.");
export type AroundQuery = z.infer<typeof AroundQuery>;

export const SegmentBody = z
  .object({
    userIds: z
      .array(z.string().min(1))
      .min(1)
      .max(
        MAX_SEGMENT_SIZE,
        `A segment is capped at ${MAX_SEGMENT_SIZE} players: D1 allows 100 bound parameters per query and each member costs one.`,
      )
      .describe(
        "The players to rank among — a friends list or any cohort. A collection dimension over the same store, not a second board.",
      ),
    limit: z.number().int().min(1).max(100).default(20).describe("How many entries to return."),
    offset: z.number().int().min(0).default(0).describe("How many entries to skip."),
    window: z.string().optional().describe("Which window to read; omit for the one open now."),
  })
  .describe("A friends or cohort view of a board.");
export type SegmentBody = z.infer<typeof SegmentBody>;

export const VisibilityBody = z
  .object({
    visible: z
      .boolean()
      .describe("Whether this player consents to appear on the board. Gates every read, including segments."),
  })
  .describe("A player's own consent to be shown. Theirs to set — a submission never resets it.");
export type VisibilityBody = z.infer<typeof VisibilityBody>;

export const HideBody = z
  .object({
    hidden: z.boolean().describe("Whether to hide this entry from every read. The score is kept, not deleted."),
  })
  .describe("A moderator's hide toggle. Separate from player consent so a player cannot undo it.");
export type HideBody = z.infer<typeof HideBody>;

// --- The management surface (#817) -------------------------------------------------------------------

/** How long a reason may be. Long enough to explain a ban; short enough that it is not a document. */
export const MAX_REASON_LENGTH = 1000;

/** How long an idempotency key may be. A UUID fits several times over. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** One page of entries, at most. The same ceiling every management listing in the kit uses. */
const AdminLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many entries to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a dashboard can render.`);

export const AdminBoardParam = z
  .object({
    board: BoardParam.shape.board.describe(
      "The board a management route addresses. A shape check only; whether it is configured is the handler's 404.",
    ),
  })
  .describe("The `:board` segment of a management route.");
export type AdminBoardParam = z.infer<typeof AdminBoardParam>;

export const AdminEntryParam = AdminBoardParam.extend({
  userId: EntryParam.shape.userId.describe("The player whose entry the act addresses."),
}).describe("The board and player a management act addresses.");
export type AdminEntryParam = z.infer<typeof AdminEntryParam>;

export const AdminEntriesQuery = z
  .object({
    window: WindowQuery.shape.window,
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page."),
    limit: AdminLimit,
    userId: EntryParam.shape.userId
      .optional()
      .describe("Read one player's entry in this window, rather than the whole board."),
    hidden: z
      .enum(["true", "false"])
      .optional()
      .describe("`true` for hidden entries only, `false` for entries not hidden. Omit for both."),
  })
  .describe("Which window of a board to read, filtered how, and where to resume.");
export type AdminEntriesQuery = z.infer<typeof AdminEntriesQuery>;

/** What every management act carries: who may replay it, and why it was done. */
const ActBody = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .max(MAX_IDEMPOTENCY_KEY_LENGTH)
    .describe(
      "A key the client mints once per act, such as a UUID. Sending the same key again answers what the first request did, and changes and emits nothing. The same key on a different act is refused.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REASON_LENGTH)
    .describe("Why, in the operator's words. Required, recorded in the entry's history and on the audit event."),
});

export const EntryActBody = ActBody.extend({
  window: WindowQuery.shape.window.describe(
    "The window the entry is in — the ISO key of a window, or `all` on an all-time board. Omit for the one open now.",
  ),
}).describe("A hide or unhide: the entry's window, an idempotency key, and a reason.");
export type EntryActBody = z.infer<typeof EntryActBody>;

export const CorrectEntryBody = EntryActBody.extend({
  score: z
    .number()
    .finite()
    .describe("The score the entry should hold. Held to the board's `min` and `max`, as a submission is."),
}).describe("A score correction: the entry's window, the new score, an idempotency key, and a reason.");
export type CorrectEntryBody = z.infer<typeof CorrectEntryBody>;

export const LockParam = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "A lock name is lowercase letters, digits and dashes.")
      .describe("The lock to clear, as the lock read names it: `rank-refresh`."),
  })
  .describe("The `:name` segment of the lock route.");
export type LockParam = z.infer<typeof LockParam>;

export const ClearLockBody = ActBody.extend({
  holder: z
    .string()
    .min(1)
    .max(255)
    .describe(
      "The holder the lock read showed. A lock that has since changed hands is refused rather than cleared, so a clear can only release the stale holder the operator saw.",
    ),
}).describe("A lock clear: the holder it was taken by, an idempotency key, and a reason.");
export type ClearLockBody = z.infer<typeof ClearLockBody>;
