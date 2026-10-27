// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace } from "@cloudflare/workers-types";
import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { kvMetadata, TypedKv } from "@pithy-sh/core/src/kv/kv";
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
    maxUses: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "How many redemptions the code was opened with. Absent on a room opened before it was recorded; the game's configured `maxUses` stands in.",
      ),
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

/**
 * What a room carries on its KV list entry, so a management client can read every open room without a value
 * read per code. Derived from the room on every write, and rebuilt on list for a room written before it existed
 * (`deriveMetadata`'s self-heal). Small by construction: ids, two counts and two ms-epoch instants.
 */
export const RoomListing = kvMetadata(
  z
    .object({
      gameKey: z.string().describe("The matchmaking game the room is for."),
      hostId: z.string().describe("The user who opened the room."),
      sessionId: z.string().describe("The multiplayer session the code joins players into."),
      usesRemaining: z.number().int().nonnegative().describe("Redemptions the code has left."),
      maxUses: z.number().int().positive().optional().describe("Redemptions the code was opened with, when recorded."),
      createdAt: z.number().int().describe("When the room was opened, ms epoch."),
      expiresAt: z.number().int().describe("When the code expires, ms epoch."),
    })
    .describe("A room's list-time summary: enough to show it without reading its value."),
);
export type RoomListing = z.output<typeof RoomListing>;

/** The list entry a room is summarized by — the same fields, dates as ms epoch. */
function roomListing(room: Room): RoomListing {
  return {
    gameKey: room.gameKey,
    hostId: room.hostId,
    sessionId: room.sessionId,
    usesRemaining: room.usesRemaining,
    ...(room.maxUses === undefined ? {} : { maxUses: room.maxUses }),
    createdAt: room.createdAt.getTime(),
    expiresAt: room.expiresAt.getTime(),
  };
}

/** A typed, Zod-validated KV view of the room store over the `MATCHMAKING` namespace. */
export function roomStore(
  namespace: KVNamespace,
  ttlSeconds: number,
): TypedKv<typeof Room, typeof RoomKey, typeof RoomListing> {
  return new TypedKv(namespace, {
    prefix: ROOM_PREFIX,
    key: RoomKey,
    value: Room,
    metadata: RoomListing,
    deriveMetadata: roomListing,
    ttlSeconds,
  });
}
