// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PresenceOrigin, PresenceParticipant, PresenceParticipantName, PresenceParticipantRef } from "./frames";
import { PresenceActivity, PresenceRecordId, PresenceRoomKindName } from "./names";

/**
 * **What a room knows, and where it keeps it: on its sockets, and nowhere else.**
 *
 * A room is one Durable Object on the Hibernation API. When it hibernates its memory goes, so everything it
 * must still know when it wakes rides in each socket's attachment, read back from `getWebSockets()`: the
 * participant, the version the socket negotiated, the room kind's rules, and which tickets have been spent.
 * Nothing is written to D1, KV or Durable Object storage. When the last socket closes, the room is gone.
 *
 * This module is the logic of that, pure, so it is tested without a runtime; `./durableObject.ts` is the
 * thin part that reads and writes attachments.
 */

/** A spent ticket: its id, and when it would have expired anyway — after which remembering it is pointless. */
export const SpentTicket = z
  .object({
    id: z.string().uuid().describe("The spent ticket's id."),
    exp: z.number().int().describe("When the ticket would have expired, in seconds since the epoch."),
  })
  .describe("A ticket a room has redeemed, kept until it would have expired.");
export type SpentTicket = z.infer<typeof SpentTicket>;

/**
 * What the Worker's socket route tells the room, on a header only the Worker can set: a verified ticket's
 * participant, the ticket itself, and the room kind's rules. The room trusts this and nothing a client sent.
 */
export const PresenceAdmission = z
  .object({
    kind: PresenceRoomKindName.describe("The room kind."),
    recordId: PresenceRecordId.describe("The record the room is about."),
    ref: PresenceParticipantRef,
    name: PresenceParticipantName,
    origin: PresenceOrigin,
    ticket: SpentTicket.describe("The ticket this socket is redeeming."),
    activities: z
      .array(PresenceActivity)
      .min(1)
      .describe("The room kind's declared activities. The first is what a participant starts as."),
    maxParticipants: z.number().int().positive().describe("The room kind's participant cap."),
  })
  .describe("A verified admission, forwarded from the Worker's socket route to the room.");
export type PresenceAdmission = z.infer<typeof PresenceAdmission>;

/** The server-set header carrying a {@link PresenceAdmission} into the room. */
export const PRESENCE_ADMISSION_HEADER = "x-pithy-presence-admission";

/** What one socket carries through hibernation. Kept far under the 16,384-byte attachment ceiling. */
export const PresenceAttachment = z
  .object({
    participant: PresenceParticipant.describe("Who this socket is, and what they are doing."),
    version: z.string().describe("The negotiated subprotocol."),
    ticket: SpentTicket.describe("The ticket this socket redeemed."),
    activities: z.array(PresenceActivity).min(1).describe("The room kind's declared activities."),
    spent: z
      .array(SpentTicket)
      .describe("Tickets redeemed by sockets that have since closed, carried so a hibernated room still refuses them."),
  })
  .describe("The participant and room state a presence socket keeps across hibernation.");
export type PresenceAttachment = z.infer<typeof PresenceAttachment>;

/** Every ticket a room still remembers as spent, from its sockets' attachments and its own memory. */
export function spentTickets(
  attachments: readonly PresenceAttachment[],
  remembered: readonly SpentTicket[],
  nowSeconds: number,
): Set<string> {
  const spent = new Set<string>();
  const add = (ticket: SpentTicket) => {
    if (ticket.exp > nowSeconds) spent.add(ticket.id);
  };
  for (const attachment of attachments) {
    add(attachment.ticket);
    for (const ticket of attachment.spent) add(ticket);
  }
  for (const ticket of remembered) add(ticket);
  return spent;
}

/** Why a room refuses an admission, or `null` to admit. */
export type AdmissionRefusal = "spent" | "full" | null;

/** Decide one admission against the room as it stands. */
export function admit(
  admission: PresenceAdmission,
  attachments: readonly PresenceAttachment[],
  remembered: readonly SpentTicket[],
  nowSeconds: number,
): AdmissionRefusal {
  if (spentTickets(attachments, remembered, nowSeconds).has(admission.ticket.id)) return "spent";
  if (attachments.length >= admission.maxParticipants) return "full";
  return null;
}

/**
 * The most spent tickets one attachment carries. A ticket is honored for 60 seconds, so this is how many
 * sockets a room may see redeemed and closed within a minute before it starts forgetting the soonest to
 * expire; at about 60 bytes each it keeps an attachment far under its 16,384-byte ceiling.
 */
export const MAX_CARRIED_SPENT = 160;

/** Unexpired, once each, never `own`, and at most {@link MAX_CARRIED_SPENT} — the latest to expire kept. */
function liveSpent(tickets: readonly SpentTicket[], own: string, nowSeconds: number): SpentTicket[] {
  const byId = new Map<string, SpentTicket>();
  for (const ticket of tickets) {
    if (ticket.exp > nowSeconds && ticket.id !== own) byId.set(ticket.id, ticket);
  }
  const live = [...byId.values()];
  return live.length > MAX_CARRIED_SPENT ? live.sort((a, b) => b.exp - a.exp).slice(0, MAX_CARRIED_SPENT) : live;
}

/**
 * The spent list a socket joining a room starts with: what the room remembers in memory, moved onto the
 * socket, where it survives hibernation. A room's memory is only for the tickets of sockets that closed with
 * no other socket left to carry them; the moment a socket is there again, it carries them.
 */
export function inheritSpent(remembered: readonly SpentTicket[], own: string, nowSeconds: number): SpentTicket[] {
  return liveSpent(remembered, own, nowSeconds);
}

/**
 * The spent list a surviving socket carries once another closes: its own, plus the closing socket's ticket
 * and everything it carried, less what has expired. Returns `null` when nothing changed, so a room writes no
 * attachment it does not need to.
 */
export function carrySpent(
  survivor: PresenceAttachment,
  closing: PresenceAttachment,
  nowSeconds: number,
): SpentTicket[] | null {
  const next = liveSpent([...survivor.spent, closing.ticket, ...closing.spent], survivor.ticket.id, nowSeconds);
  const same =
    next.length === survivor.spent.length && next.every((ticket, index) => survivor.spent[index]?.id === ticket.id);
  return same ? null : next;
}

/** Whether a client may announce this activity in this room. */
export function declaresActivity(attachment: PresenceAttachment, activity: string): boolean {
  return attachment.activities.includes(activity);
}
