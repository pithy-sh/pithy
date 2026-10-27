// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PresenceParticipantName, PresenceParticipantRef } from "../frames";
import { PresenceRecordId, PresenceRoomKindName } from "../names";

/** The room a ticket is for. */
const room = {
  kind: PresenceRoomKindName.describe("The room kind, as the manifest lists it — `support.thread`."),
  recordId: PresenceRecordId.describe("The record the room is about."),
};

/** `POST {base}/presence/tickets` — a signed-in user asks to join a room. The participant is that user. */
export const PresenceSessionTicketRequest = z
  .object(room)
  .describe("The room a signed-in user asks a presence ticket for. The participant is the caller.");
export type PresenceSessionTicketRequest = z.infer<typeof PresenceSessionTicketRequest>;

/**
 * `POST /control-plane/presence/tickets` — a management client asks to join a room, naming its participant.
 * The body is signed with the call, which is what makes the participant the client's own claim.
 */
export const ControlPlanePresenceTicketRequest = z
  .object({
    ...room,
    participant: z
      .object({
        ref: PresenceParticipantRef,
        name: PresenceParticipantName,
      })
      .describe("Who joins: the client's own opaque reference for them, and the name the others see."),
  })
  .describe("The room a management client asks a presence ticket for, and who joins it.");
export type ControlPlanePresenceTicketRequest = z.infer<typeof ControlPlanePresenceTicketRequest>;

/** The socket route's path parameters. */
export const PresenceRoomParams = z.object(room).describe("The room a presence socket joins: its kind and its record.");
export type PresenceRoomParams = z.infer<typeof PresenceRoomParams>;
