import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { TypedKv } from "@pithy-sh/core/src/kv/kv";
import { z } from "zod";

/**
 * A room — a short, shareable join code pointing at an already-minted multiplayer session. Stored in KV
 * (namespace `MATCHMAKING`) under `matchmaking:<code>`, with a TTL so it expires, and a `usesRemaining`
 * counter so it is limited-use. Zod-validated on every read and write.
 */
export const Room = z
  .object({
    code: z.string().describe("The room's shareable code, e.g. WXYZ-1234."),
    gameKey: z.string().describe("The matchmaking game the room is for."),
    hostId: z.string().describe("The authenticated user who opened the room (the session's creator)."),
    sessionId: z.string().describe("The multiplayer session id the room's code joins players into."),
    usesRemaining: z
      .number()
      .int()
      .nonnegative()
      .describe("How many redemptions the code has left before it is spent."),
    createdAt: JsonDate.describe("When the room was opened."),
    expiresAt: JsonDate.describe(
      "When the code expires — used to recompute the KV TTL on each redemption without resetting the window.",
    ),
  })
  .describe("A room-code entry: a limited-use, short-lived pointer to a multiplayer session.");
export type Room = z.output<typeof Room>;

/** The KV key for a room — its code. Physical key: `matchmaking:<code>`. */
export const RoomKey = z.object({ code: z.string().describe("The room code (the key).") }).describe("Room KV key.");

/** The fixed KV namespace prefix for room entries. */
export const ROOM_PREFIX = "matchmaking";

/** A typed, Zod-validated KV view of the room store over the `MATCHMAKING` namespace. */
export function roomStore(namespace: KVNamespace, ttlSeconds: number): TypedKv<typeof Room, typeof RoomKey> {
  return new TypedKv(namespace, { prefix: ROOM_PREFIX, key: RoomKey, value: Room, ttlSeconds });
}
