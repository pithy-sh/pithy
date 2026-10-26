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
      .describe("The multiplayer session minted when the invite was accepted, or null otherwise."),
    createdAt: z.iso.datetime().describe("When the invite was sent, ISO-8601."),
    respondedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the invitee accepted or declined, or a management client canceled it, ISO-8601, or null while pending.",
      ),
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

/*
 * ## The management routes
 *
 * What the control-plane routes under `admin/` return. A management client reads these against a customer's
 * Worker on whatever release it runs, so a field added here later is `.optional()` as well as `.nullable()`.
 */

/** One waiting player in a game's queue. */
export const AdminQueueTicket = z
  .object({
    userId: z.string().describe("The waiting player's auth user id."),
    region: z.string().describe("The region bucket the player is pinned to. A pair never crosses regions."),
    skill: z
      .number()
      .nullable()
      .describe("The player's skill in the game's rating pool, or null when unrated or the game has no pool."),
    skillBand: z
      .number()
      .nullable()
      .describe(
        "How far either side of `skill` the player will match right now, or null when unbounded: unrated, or waiting past `maxWaitSeconds`.",
      ),
    enqueuedAt: z.iso.datetime().describe("When the player joined the queue, ISO-8601."),
    waitingMs: z.number().int().nonnegative().describe("How long the player has waited, in milliseconds."),
  })
  .describe("One player waiting in a game's open queue, as the coordinator holds them.");
export type AdminQueueTicket = z.infer<typeof AdminQueueTicket>;

/** A game's queue, read from its coordinator. */
export const AdminQueue = z
  .object({
    gameKey: z.string().describe("The game whose queue this is."),
    waiting: z.array(AdminQueueTicket).describe("Everyone waiting, longest wait first."),
  })
  .describe("Who is waiting in one game's open queue, read from the queue's Durable Object.");
export type AdminQueue = z.infer<typeof AdminQueue>;

/** One open room. */
export const AdminRoomView = z
  .object({
    code: z.string().describe("The room's join code."),
    hostId: z.string().describe("The user who opened the room."),
    sessionId: z.string().describe("The multiplayer session the code seats players into."),
    occupancy: z.number().int().positive().describe("The host plus every player who redeemed the code."),
    capacity: z.number().int().positive().describe("How many players form a match in this game."),
    usesRemaining: z.number().int().positive().describe("How many more times the code can be redeemed."),
    createdAt: z.iso.datetime().describe("When the room was opened, ISO-8601."),
    expiresAt: z.iso.datetime().describe("When the code expires, ISO-8601."),
  })
  .describe("One open room: a live code with a redemption left.");
export type AdminRoomView = z.infer<typeof AdminRoomView>;

/** One page of a game's open rooms. */
export const AdminRoomList = z
  .object({
    gameKey: z.string().describe("The game these rooms are for."),
    rooms: z
      .array(AdminRoomView)
      .describe(
        "The open rooms on this page. Codes for every game share one list, so a page can hold fewer than asked.",
      ),
    nextCursor: z
      .string()
      .nullable()
      .describe("Where the next page resumes, or null at the end. A page with few rooms can still have a next one."),
  })
  .describe("One game's open rooms, a page at a time.");
export type AdminRoomList = z.infer<typeof AdminRoomList>;

/** One pending invite, as a management client reads it. */
export const AdminInviteView = z
  .object({
    id: z.string().describe("The invite's UUID, the id the cancel route takes."),
    gameKey: z.string().describe("The matchmaking game the invite is for."),
    inviterId: z.string().describe("The user who sent the invite."),
    inviteeId: z.string().describe("The user the invite was sent to."),
    createdAt: z.iso.datetime().describe("When the invite was sent, ISO-8601."),
    ageMs: z.number().int().nonnegative().describe("How long the invite has waited, in milliseconds."),
  })
  .describe("One pending invite: who asked whom, to play what, and how long ago.");
export type AdminInviteView = z.infer<typeof AdminInviteView>;

/** One page of pending invites. */
export const AdminInviteList = z
  .object({
    invites: z.array(AdminInviteView).describe("The pending invites on this page, newest first."),
    nextCursor: z.string().nullable().describe("Where the next page resumes, or null at the end."),
  })
  .describe("Every pending invite, a page at a time.");
export type AdminInviteList = z.infer<typeof AdminInviteList>;

/** What canceling an invite returns. */
export const AdminInviteCanceled = z
  .object({
    invite: InviteView.describe("The invite as it now stands: canceled."),
    replayed: z
      .boolean()
      .describe(
        "True when this idempotency key had already canceled this invite. Nothing changed, and nobody was told.",
      ),
  })
  .describe("A canceled invite, and whether the request was a retry.");
export type AdminInviteCanceled = z.infer<typeof AdminInviteCanceled>;

/** What dropping a player from a queue returns. */
export const AdminQueuePlayerDropped = z
  .object({
    gameKey: z.string().describe("The game whose queue the player left."),
    userId: z.string().describe("The player dropped."),
    replayed: z
      .boolean()
      .describe(
        "True when this idempotency key had already dropped this player. Nothing changed, and nobody was told.",
      ),
  })
  .describe("A player dropped from a game's open queue, and whether the request was a retry.");
export type AdminQueuePlayerDropped = z.infer<typeof AdminQueuePlayerDropped>;
