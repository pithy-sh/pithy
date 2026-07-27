import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The state of a friend edge. */
export const FriendStatus = z
  .enum(["pending", "accepted"])
  .describe("A friend edge's state: a request awaiting acceptance, or a mutual connection.");
export type FriendStatus = z.infer<typeof FriendStatus>;

/**
 * One edge of the symmetric friend graph — the row in `pithy_matchmaking_friends`. A pair is stored once,
 * canonicalized so `userA < userB`; `requestedBy` records who initiated a pending request (the other
 * accepts). Either party can remove an accepted edge. The unique `(userA, userB)` index makes the pairing
 * idempotent.
 */
export const Friendship = z
  .object({
    id: z.number().int().describe("Autoincrement PK. Internal only."),
    userA: z.string().describe("The lexicographically smaller user id of the pair (canonical ordering)."),
    userB: z.string().describe("The lexicographically larger user id of the pair (canonical ordering)."),
    status: FriendStatus.describe("Whether the edge is a pending request or an accepted friendship."),
    requestedBy: z.string().describe("Which of the two users sent the request — the other one accepts it."),
    createdAt: SQLiteDate.describe("When the request was sent."),
    updatedAt: SQLiteDate.describe("When the edge last changed (e.g. on acceptance)."),
  })
  .describe("One symmetric friend edge between two users.");
export type Friendship = z.output<typeof Friendship>;
export type FriendshipRow = z.input<typeof Friendship>;
