// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { FriendStatus } from "../data/friend";
import { InviteStatus } from "../data/invite";

/**
 * What the matchmaking routes return, as Zod objects a client can validate against and the OpenAPI
 * contract can describe.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. These describe JSON on
 * the wire, so a date is the ISO-8601 string `c.json` writes, and nothing here carries a codec or a
 * transform: parsing a response hands back exactly what went in, which is what lets
 * `routes.workers.test.ts` parse a real answer and compare it with the original.
 *
 * **A field added here later is `.optional()` as well as `.nullable()`.** A client generated from the
 * contract reads Workers on older releases too, and a required key they cannot send fails it outright.
 */

/** What opening a room returns. */
export const RoomCreated = z
  .object({
    code: z.string().describe("The shareable join code, in the canonical `WXYZ-1234` form."),
    sessionId: z.string().describe("The multiplayer session the room seats players into. The host is already in it."),
  })
  .describe("A freshly opened room: its join code and the session behind it.");
export type RoomCreated = z.infer<typeof RoomCreated>;

/** What redeeming a room code returns. */
export const RoomJoined = z
  .object({
    sessionId: z.string().describe("The multiplayer session the caller was seated into."),
    usesRemaining: z.number().int().describe("How many more times the code can be redeemed after this join."),
  })
  .describe("The session a room code seated the caller into.");
export type RoomJoined = z.infer<typeof RoomJoined>;

/** One direct invite, as the routes return it. */
export const InviteView = z
  .object({
    id: z.string().describe("The invite's UUID, the id the accept and decline routes take."),
    gameKey: z.string().describe("The matchmaking game the invite is for."),
    inviterId: z.string().describe("The user who sent the invite."),
    inviteeId: z.string().describe("The user the invite was sent to."),
    status: InviteStatus.describe("The invite's current state."),
    sessionId: z
      .string()
      .nullable()
      .describe("The multiplayer session minted when the invite was accepted, or null while pending or declined."),
    createdAt: z.iso.datetime().describe("When the invite was sent, ISO-8601."),
    respondedAt: z.iso
      .datetime()
      .nullable()
      .describe("When the invitee accepted or declined, ISO-8601, or null while pending."),
  })
  .describe("One direct invite from one player to another.");
export type InviteView = z.infer<typeof InviteView>;

/** The caller's pending invites. */
export const InviteList = z
  .object({
    invites: z.array(InviteView).describe("The invites sent to the caller that still await a response."),
  })
  .describe("The direct invites waiting on the caller.");
export type InviteList = z.infer<typeof InviteList>;

/** One friend edge from the caller's side. */
export const FriendView = z
  .object({
    userId: z.string().describe("The other user in the edge."),
    status: FriendStatus.describe("Whether the edge is a pending request or an accepted friendship."),
    direction: z
      .enum(["incoming", "outgoing", "mutual"])
      .describe(
        "For a pending request, `outgoing` when the caller sent it and `incoming` when the other user did. `mutual` once accepted.",
      ),
    since: z.iso.datetime().describe("When the edge last changed, ISO-8601."),
  })
  .describe("One friend edge, seen from the caller's side.");
export type FriendView = z.infer<typeof FriendView>;

/** The caller's friend graph. */
export const FriendList = z
  .object({
    friends: z.array(FriendView).describe("Every friend edge the caller is part of, pending or accepted."),
  })
  .describe("The caller's friends and pending friend requests.");
export type FriendList = z.infer<typeof FriendList>;

/** The caller's standing in a game's open queue. */
export const QueueStanding = z
  .object({
    state: z
      .enum(["queued", "matched"])
      .describe("`queued` while the caller waits, `matched` once a full roster formed around them."),
    sessionId: z
      .string()
      .nullable()
      .describe("The multiplayer session the match was seated into, or null while still queued."),
    waitingMs: z.number().describe("How long the caller has waited, in milliseconds. 0 on enqueue and once matched."),
  })
  .describe("The caller's standing in a game's open queue.");
export type QueueStanding = z.infer<typeof QueueStanding>;
