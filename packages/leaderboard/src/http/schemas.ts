// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { BOARD_KEY_PATTERN } from "../config/config";
import { MAX_SEGMENT_SIZE } from "../rank/query";

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
