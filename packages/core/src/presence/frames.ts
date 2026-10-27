// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ErrorBody } from "../error/wire";
import type { SocketVersions } from "../http/subprotocol";
import { PresenceActivity } from "./names";

/**
 * **Every frame on a presence room socket, as the Zod schema it is sent and parsed with.**
 *
 * Pure: zod and core's leaf modules. A browser imports it to type the socket, and the AsyncAPI document
 * reads the same schemas through the declaring capability's `sockets`, so the document and the Durable
 * Object cannot disagree.
 *
 * **How a client reads a frame, stated once** (`docs/SOCKETS.md`). A field added to a frame later is
 * optional. A client ignores a `type` and a key it does not know. A change no client could ignore is a new
 * subprotocol, and the Worker keeps serving the one before it.
 *
 * **The keepalive is plain text**, the one exception to JSON: a client sends `ping`, the Worker answers
 * `pong`. The only JSON frame a client sends is `set_activity`.
 */

/** The subprotocols a room serves. There is no unversioned room: a ticket can only arrive in the offer. */
export const PRESENCE_ROOM_VERSIONS: SocketVersions = { current: "pithy.presence.v1", previous: null };

/** Which door a participant came in by. */
export const PresenceOrigin = z
  .enum(["control-plane", "session"])
  .describe(
    "Which door the participant came in by: `control-plane`, a management client such as the dashboard, or `session`, a signed-in user of the app.",
  );
export type PresenceOrigin = z.infer<typeof PresenceOrigin>;

/** Who a participant is, as the minting door states it. */
export const PresenceParticipantRef = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Who the participant is. A management client's own opaque reference, which it chose; or the signed-in user's id, which the Worker chose.",
  );

/** The longest participant name, in UTF-16 code units — what zod's `.max` counts. */
export const PRESENCE_PARTICIPANT_NAME_MAX = 80;

/** How the others see a participant. */
export const PresenceParticipantName = z
  .string()
  .trim()
  .min(1)
  .max(PRESENCE_PARTICIPANT_NAME_MAX)
  .describe("How the other participants see this one. A label, never an identity — `ref` and `origin` are that.");

/** One participant in a room. */
export const PresenceParticipant = z
  .object({
    id: z
      .string()
      .uuid()
      .describe("This participant's id in the room — one per socket, so one person in two tabs is two participants."),
    ref: PresenceParticipantRef,
    name: PresenceParticipantName,
    origin: PresenceOrigin,
    activity: PresenceActivity.describe("What they are doing now, one of the room kind's declared activities."),
    joinedAt: z.iso.datetime().describe("When this socket joined, ISO-8601."),
  })
  .describe("One participant in a presence room: one open socket.");
export type PresenceParticipant = z.infer<typeof PresenceParticipant>;

/** The first frame on every room socket. */
export const PresenceRoomInitFrame = z
  .object({
    type: z.literal("init").describe("Always `init`."),
    self: z.string().uuid().describe("This socket's own participant id, so a client can find itself in the list."),
    participants: z
      .array(PresenceParticipant)
      .describe("Everyone in the room now, this socket included, in the order they joined."),
  })
  .describe("Who is in the room, sent once as soon as the socket opens.");
export type PresenceRoomInitFrame = z.infer<typeof PresenceRoomInitFrame>;

/** Someone joined. */
export const PresenceJoinedFrame = z
  .object({
    type: z.literal("joined").describe("Always `joined`."),
    participant: PresenceParticipant.describe("Who joined."),
  })
  .describe("Another participant joined the room.");
export type PresenceJoinedFrame = z.infer<typeof PresenceJoinedFrame>;

/** Someone left, or their socket dropped. */
export const PresenceLeftFrame = z
  .object({
    type: z.literal("left").describe("Always `left`."),
    participantId: z.string().uuid().describe("The participant who left."),
  })
  .describe("Another participant left the room, or their socket dropped.");
export type PresenceLeftFrame = z.infer<typeof PresenceLeftFrame>;

/** Someone changed what they are doing. */
export const PresenceActivityFrame = z
  .object({
    type: z.literal("activity").describe("Always `activity`."),
    participantId: z.string().uuid().describe("The participant whose activity changed."),
    activity: PresenceActivity.describe("What they are doing now."),
  })
  .describe("Another participant announced a different activity.");
export type PresenceActivityFrame = z.infer<typeof PresenceActivityFrame>;

/** A frame the room could not accept. */
export const PresenceRoomErrorFrame = z
  .object({
    type: z.literal("error").describe("Always `error`."),
    error: ErrorBody.shape.error,
  })
  .describe(
    "The room could not accept a frame — not one it reads, an activity the room kind does not declare, or past the size limit. The error is the one an HTTP response would carry.",
  );
export type PresenceRoomErrorFrame = z.infer<typeof PresenceRoomErrorFrame>;

/** Every JSON frame the Worker sends on a room socket. `pong` is the plain-text exception. */
export const PresenceRoomServerFrame = z
  .discriminatedUnion("type", [
    PresenceRoomInitFrame,
    PresenceJoinedFrame,
    PresenceLeftFrame,
    PresenceActivityFrame,
    PresenceRoomErrorFrame,
  ])
  .describe("A JSON frame the Worker sends on a presence room socket.");
export type PresenceRoomServerFrame = z.infer<typeof PresenceRoomServerFrame>;

/** Announce a different activity. */
export const PresenceSetActivityFrame = z
  .object({
    type: z.literal("set_activity").describe("Always `set_activity`."),
    activity: PresenceActivity.describe("What this participant is doing now. One of the room kind's declared values."),
  })
  .describe("Announce what this participant is doing now.");
export type PresenceSetActivityFrame = z.infer<typeof PresenceSetActivityFrame>;

/** Every JSON frame a client may send on a room socket. `ping` is the plain-text exception. */
export const PresenceRoomClientFrame = z
  .discriminatedUnion("type", [PresenceSetActivityFrame])
  .describe("A JSON frame a client sends on a presence room socket.");
export type PresenceRoomClientFrame = z.infer<typeof PresenceRoomClientFrame>;

/** The keepalive a client sends, as plain text. */
export const PresenceRoomPing = z.literal("ping").describe("The plain-text keepalive a client sends.");

/** The Worker's answer to `ping`, as plain text. */
export const PresenceRoomPong = z.literal("pong").describe("The plain-text answer to `ping`.");
