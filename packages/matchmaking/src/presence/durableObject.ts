// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { clientError } from "@pithy-sh/core/src/error/client";
import { fromZodError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { negotiateSubprotocol, SUBPROTOCOL_HEADER } from "@pithy-sh/core/src/http/subprotocol";
import { z } from "zod";
import { matchmakingDatabase } from "../data/tables";
import { friendStore } from "../friends/store";
import { inviteView } from "../http/views";
import { inviteStore } from "../invite/store";
import {
  PRESENCE_VERSIONS,
  PresenceClientFrame,
  type PresenceEvent,
  PresencePong,
  type PresenceServerFrame,
} from "./frames";
import { PRESENCE_USER_HEADER } from "./protocol";

// The header and the event shapes are **not** re-exported from here. They live in `./protocol` and are
// imported from there by everyone, DO included. Re-exporting them made this module a legal source for two
// pure values, and a value import out of a `cloudflare:workers` module is exactly how #172 reached
// multiplayer's config path — the routes only needed two constants, and they took the whole DO with them.
// One source per value, and it is the pure one.

/**
 * Presence — a single Durable Object (addressed by a fixed name) holding every online player's WebSocket
 * via the Hibernation API. On connect it delivers a player's pending invites and which of their friends
 * are currently online; thereafter `notify()` pushes real-time events (a match found, an invite received,
 * a friend request). "Friends online" is the intersection of a user's friend graph with the connected
 * set. A single shared object has a soft ~1,000 req/s ceiling — adequate for notifications; noted as a
 * scaling consideration.
 *
 * Platform discipline (mirrors the multiplayer session DO): the WebSocket Hibernation API only (never
 * `ws.accept()`), the authenticated identity stashed with `serializeAttachment` so it survives eviction,
 * and no in-memory connection registry — the live set is always read back from `getWebSockets()`.
 */
export interface MatchmakingPresenceEnv {
  DB: D1Database;
}

/**
 * What each socket carries through hibernation: who it is, and the subprotocol it negotiated. A socket
 * accepted before versions existed carries no `version`, and reads as the unversioned socket it is.
 */
const PresenceAttachment = z
  .object({
    userId: z.string().describe("The authenticated user id the upgrade was forwarded with."),
    version: z
      .string()
      .nullable()
      .optional()
      .describe("The negotiated subprotocol, or null for an unversioned client. Absent on an older socket."),
  })
  .describe("The identity and version a presence socket keeps across hibernation.");
type PresenceAttachment = z.infer<typeof PresenceAttachment>;

/**
 * Render a frame for one socket's version. `pithy.presence.v1` and the unversioned socket speak the same
 * frames today, so both render the same JSON. The version is read here so a later one has one place to
 * branch.
 */
function render(frame: PresenceServerFrame, _version: string | null): string {
  return JSON.stringify(frame);
}

export class MatchmakingPresence extends DurableObject<MatchmakingPresenceEnv> {
  /**
   * WebSocket upgrade — accepts the connection (Hibernation API) and sends the initial presence payload. The
   * upgrade is forwarded by the authenticated Hono handler, which sets {@link PRESENCE_USER_HEADER} to the
   * AuthContext user id; the DO trusts that server-set header and never a client-supplied id.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const userId = request.headers.get(PRESENCE_USER_HEADER);
    if (!userId) return new Response("Missing authenticated user.", { status: 401 });

    // The version is settled before the socket exists. A client offering only versions this Worker does not
    // serve is refused with the error an HTTP route would send: a socket that opened anyway would speak
    // frames the client cannot read.
    let version: string | null;
    try {
      version = negotiateSubprotocol(request.headers.get(SUBPROTOCOL_HEADER), PRESENCE_VERSIONS);
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      return Response.json({ error: clientError(error.payload) }, { status: error.payload.status });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API — never `server.accept()`, which would pin the object in memory. The `userId` tag lets
    // the runtime hand this user's sockets back after eviction.
    this.ctx.acceptWebSocket(server, [userId]);
    // A tiny attachment (well under the 16,384-byte ceiling): the identity and version that survive hibernation.
    server.serializeAttachment({ userId, version } satisfies PresenceAttachment);

    // The connect payload: this player's pending invites, plus which of their accepted friends are online now.
    // Each invite is projected through the same view the HTTP routes describe, never the stored row.
    const db = matchmakingDatabase(this.env.DB);
    const pendingInvites = (await inviteStore(db).pendingFor(userId)).map(inviteView);
    const friends = await friendStore(db).list(userId);
    const accepted = new Set(friends.filter((edge) => edge.status === "accepted").map((edge) => edge.userId));
    const onlineFriends = this.connectedUserIds().filter((id) => accepted.has(id));
    server.send(render({ type: "init", pendingInvites, onlineFriends }, version));

    // A browser drops a socket whose 101 does not name the subprotocol it chose, so the answer carries it.
    const headers = version === null ? undefined : { [SUBPROTOCOL_HEADER]: version };
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /** Push an event to a connected user's sockets. A no-op if the user is offline. */
  async notify(userId: string, event: PresenceEvent): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.attachment(ws);
      if (attachment?.userId !== userId) continue;
      try {
        ws.send(render(event, attachment.version ?? null));
      } catch {
        // A dead socket — skip it; the player resyncs on reconnect. One bad socket never blocks the rest.
      }
    }
  }

  /** The user ids currently connected — distinct, read back from each socket's attachment (hibernation-safe). */
  connectedUserIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.attachment(ws)?.userId;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /**
   * Keepalive only — presence carries no client-authoritative state. Every frame is parsed with the
   * client-to-server schema, which is the plain-text `ping`, and a `ping` gets `pong` on every version. What
   * happens to anything else depends on the version: a `pithy.presence.v1` socket gets a
   * `validation/invalid_input` error frame, and an unversioned socket is ignored silently, exactly as it was
   * before versions existed — that client was never told to expect an `error` frame.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = PresenceClientFrame.safeParse(text);
    try {
      if (parsed.success) {
        ws.send(PresencePong.value);
        return;
      }
      const version = this.attachment(ws)?.version ?? null;
      if (version === null) return;
      const error = fromZodError(parsed.error, { message: "This socket accepts only `ping`." });
      ws.send(render({ type: "error", error: clientError(error.payload) }, version));
    } catch {
      // Socket is closing — nothing to answer.
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Nothing authoritative lives on the socket; a reconnecting player re-upgrades and gets a fresh payload.
    try {
      ws.close();
    } catch {
      // Already closing — ignore.
    }
  }

  /** The identity and version stashed on a socket, or undefined for a socket that carries neither. */
  private attachment(ws: WebSocket): PresenceAttachment | undefined {
    const parsed = PresenceAttachment.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : undefined;
  }
}
