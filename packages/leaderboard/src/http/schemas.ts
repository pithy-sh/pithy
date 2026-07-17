import { z } from "zod";
import { MAX_SEGMENT_SIZE } from "../rank/query";

/**
 * The HTTP boundary shapes. Everything a client can send is parsed through one of these before it
 * reaches a handler.
 *
 * Note what is absent from {@link SubmitScoreBody}: `userId`, `achievedAt`, and `rank`. The player comes
 * from the AuthContext seam, the clock comes from the server, and the rank is derived — a client that
 * could set any of them could score as someone else, backdate its way past the tiebreak, or simply
 * declare itself first. Server-authoritative is not only about who may call submit; it is about which
 * fields a caller may name at all.
 */

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
}).describe("The slice of a board centred on the calling player.");
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
