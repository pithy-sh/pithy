// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ErrorBody } from "@pithy-sh/core/src/error/wire";
import type { SocketVersions } from "@pithy-sh/core/src/http/subprotocol";
import { z } from "zod";
import { InviteView } from "../http/responses";

/**
 * **Every frame on the presence socket, as the Zod schema it is sent and parsed with.**
 *
 * This module is pure: zod, core's leaf modules, and this package's response schemas. No
 * `cloudflare:workers`, no Hono. A browser or a game client imports it to type the socket, and the AsyncAPI
 * document reads the same schemas through the capability's `sockets` declaration, so what the document
 * says and what the Durable Object sends cannot drift.
 *
 * **How a client reads a frame, stated once.** A field added to a frame later is optional. A client ignores
 * a `type` it does not know and a key it does not know. A change no client could ignore is a new
 * subprotocol, negotiated at the upgrade, and the Worker keeps serving the previous one.
 *
 * **The one exception to JSON.** The keepalive is plain text: a client sends `ping` and the Worker answers
 * `pong`. It is the only frame a client sends, so the client-to-server schema is the literal `ping`.
 * Anything else that arrives on a `pithy.presence.v1` socket is answered with a `validation/invalid_input`
 * error frame; on the unversioned socket it is ignored silently, as it always was, because that client was
 * never promised an `error` frame.
 */

/** The subprotocols the presence socket serves. The previous one is the unversioned socket. */
export const PRESENCE_VERSIONS: SocketVersions = { current: "pithy.presence.v1", previous: null };

/** The first frame on every presence socket. */
export const PresenceInitFrame = z
  .object({
    type: z.literal("init").describe("Always `init`."),
    pendingInvites: z
      .array(InviteView)
      .describe("The invites waiting on this player, newest first. The same view `GET /invites` returns."),
    onlineFriends: z
      .array(z.string())
      .describe("The user ids of this player's accepted friends who hold a presence socket right now."),
  })
  .describe("What the Worker sends once, as soon as the socket opens.");
export type PresenceInitFrame = z.infer<typeof PresenceInitFrame>;

/** A match was formed for this player. */
export const PresenceMatchFoundFrame = z
  .object({
    type: z.literal("match_found").describe("Always `match_found`."),
    sessionId: z.string().describe("The multiplayer session the player was seated into."),
    gameKey: z.string().describe("The matchmaking game the session plays."),
  })
  .describe("A match formed around this player, from the open queue or an accepted invite.");
export type PresenceMatchFoundFrame = z.infer<typeof PresenceMatchFoundFrame>;

/** Another player invited this one. */
export const PresenceInviteFrame = z
  .object({
    type: z.literal("invite").describe("Always `invite`."),
    inviteId: z.string().describe("The invite's UUID, the id the accept and decline routes take."),
    gameKey: z.string().describe("The matchmaking game the invite is for."),
    from: z.string().describe("The user id of the player who sent it."),
  })
  .describe("Another player sent this one a direct invite.");
export type PresenceInviteFrame = z.infer<typeof PresenceInviteFrame>;

/** Another player asked to be friends. */
export const PresenceFriendRequestFrame = z
  .object({
    type: z.literal("friend_request").describe("Always `friend_request`."),
    from: z.string().describe("The user id of the player who sent the request."),
  })
  .describe("Another player sent this one a friend request.");
export type PresenceFriendRequestFrame = z.infer<typeof PresenceFriendRequestFrame>;

/** A frame the socket could not accept. */
export const PresenceErrorFrame = z
  .object({
    type: z.literal("error").describe("Always `error`."),
    error: ErrorBody.shape.error,
  })
  .describe(
    "The Worker could not accept a frame. The error is the one an HTTP response would carry. Sent on `pithy.presence.v1` only; the unversioned socket ignores a frame it cannot accept.",
  );
export type PresenceErrorFrame = z.infer<typeof PresenceErrorFrame>;

/** What `notify()` pushes to a connected player, as something happens. */
export const PresenceEvent = z
  .discriminatedUnion("type", [PresenceMatchFoundFrame, PresenceInviteFrame, PresenceFriendRequestFrame])
  .describe("An event pushed to a connected player as it happens.");
export type PresenceEvent = z.infer<typeof PresenceEvent>;

/** Every JSON frame the Worker sends on the presence socket. `pong` is the plain-text exception. */
export const PresenceServerFrame = z
  .discriminatedUnion("type", [
    PresenceInitFrame,
    PresenceMatchFoundFrame,
    PresenceInviteFrame,
    PresenceFriendRequestFrame,
    PresenceErrorFrame,
  ])
  .describe("A JSON frame the Worker sends on the presence socket.");
export type PresenceServerFrame = z.infer<typeof PresenceServerFrame>;

/** The keepalive a client sends, as plain text. */
export const PresencePing = z.literal("ping").describe("The plain-text keepalive a client sends.");
export type PresencePing = z.infer<typeof PresencePing>;

/** The Worker's answer to `ping`, as plain text. */
export const PresencePong = z.literal("pong").describe("The plain-text answer to `ping`.");
export type PresencePong = z.infer<typeof PresencePong>;

/** Every frame a client may send on the presence socket. Only the keepalive, so only `ping`. */
export const PresenceClientFrame = PresencePing;
export type PresenceClientFrame = z.infer<typeof PresenceClientFrame>;
