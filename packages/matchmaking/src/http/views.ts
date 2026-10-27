// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OpenRoom } from "../code/room";
import type { Invite } from "../data/invite";
import type { WaitingEntry } from "../queue/matching";
import type { AdminInviteView, AdminQueueTicket, AdminRoomView, InviteView } from "./responses";

/**
 * The projections that fill the response schemas in `./responses`: each takes a stored row and returns
 * the view type `c.json` sends. Every invite on the wire goes through here — the HTTP invite routes and the
 * presence socket's `init` frame alike — so a column added to the table later reaches no client until it is
 * added here on purpose.
 */

/** One invite as the wire carries it, field by field, dates as ISO-8601. */
export function inviteView(invite: Invite): InviteView {
  return {
    id: invite.id,
    gameKey: invite.gameKey,
    inviterId: invite.inviterId,
    inviteeId: invite.inviteeId,
    status: invite.status,
    sessionId: invite.sessionId,
    createdAt: invite.createdAt.toISOString(),
    respondedAt: invite.respondedAt === null ? null : invite.respondedAt.toISOString(),
  };
}

/** One waiting player as a management client reads the queue, their wait measured at `now`. */
export function adminQueueTicket(entry: WaitingEntry, now: Date): AdminQueueTicket {
  const enqueuedAt = new Date(entry.enqueuedAt);
  return {
    userId: entry.userId,
    region: entry.region,
    skill: entry.skill,
    skillBand: entry.skillBand,
    enqueuedAt: enqueuedAt.toISOString(),
    waitingMs: Math.max(0, now.getTime() - entry.enqueuedAt),
  };
}

/** One open room, with the game's roster size as its capacity. */
export function adminRoomView(room: OpenRoom, capacity: number): AdminRoomView {
  return {
    code: room.code,
    hostId: room.hostId,
    sessionId: room.sessionId,
    occupancy: room.occupancy,
    capacity,
    usesRemaining: room.usesRemaining,
    createdAt: room.createdAt.toISOString(),
    expiresAt: room.expiresAt.toISOString(),
  };
}

/** One pending invite as a management client reads it, its age measured at `now`. Never the cancel key. */
export function adminInviteView(invite: Invite, now: Date): AdminInviteView {
  return {
    id: invite.id,
    gameKey: invite.gameKey,
    inviterId: invite.inviterId,
    inviteeId: invite.inviteeId,
    createdAt: invite.createdAt.toISOString(),
    ageMs: Math.max(0, now.getTime() - invite.createdAt.getTime()),
  };
}
