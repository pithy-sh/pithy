// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ControlPlaneScope } from "../../controlPlane/scope/scope";
import { PRESENCE_ROOM_VERSIONS } from "../frames";
import { PresenceActivity, PresenceRecordId, PresenceRoomKindName } from "../names";

/**
 * A minted presence ticket and where to spend it. Both ticket routes answer it.
 *
 * Read across a version boundary like every response schema, so a field added here later is `.optional()`.
 */
export const PresenceTicket = z
  .object({
    ticket: z
      .string()
      .min(1)
      .describe(
        "The ticket. Offer it in `Sec-WebSocket-Protocol` as `pithy.ticket.<ticket>`, beside `protocol`. Single use.",
      ),
    expiresAt: z.iso.datetime().describe("When the ticket stops being honored, ISO-8601 — 60 seconds after minting."),
    kind: PresenceRoomKindName.describe("The room kind the ticket admits to."),
    recordId: PresenceRecordId.describe("The record the room is about."),
    socketPath: z
      .string()
      .min(1)
      .describe("The path to open the socket at, on this Worker — this room's, already filled in."),
    protocol: z
      .literal(PRESENCE_ROOM_VERSIONS.current)
      .describe("The subprotocol to offer beside the ticket. The Worker answers with it."),
  })
  .describe("A single-use, 60-second ticket into one presence room, and where to open the socket with it.");
export type PresenceTicket = z.infer<typeof PresenceTicket>;

/**
 * One room kind, as `GET /control-plane/manifest` reports it under the capability that declares it. Built
 * from the capability's resolved `basePath`, so a client never assumes where a socket is.
 */
export const PresenceRoomDescriptor = z
  .object({
    kind: PresenceRoomKindName.describe("The room kind — `support.thread`."),
    scope: ControlPlaneScope.describe(
      "The scope that reads the record, and so joins its room. A management client mints its ticket with exactly this scope.",
    ),
    activities: z
      .array(PresenceActivity)
      .min(1)
      .describe("What a participant may announce. The first is what everyone starts as."),
    maxParticipants: z.number().int().positive().describe("How many participants the room admits at once."),
    sessionTicketPath: z
      .string()
      .nullable()
      .describe(
        "Where a signed-in user of the app mints a ticket for this kind, or null when the kind admits management clients only.",
      ),
    socketPath: z
      .string()
      .min(1)
      .describe("The socket route, with `:kind` and `:recordId` to fill in — the path as the Worker mounted it."),
  })
  .describe("One presence room kind this capability serves, and how to join one of its rooms.");
export type PresenceRoomDescriptor = z.infer<typeof PresenceRoomDescriptor>;
