// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import { matchmakingDatabase } from "../data/tables";
import { friendStore } from "../friends/store";
import { inviteStore } from "../invite/store";
import { PRESENCE_USER_HEADER, type PresenceEvent } from "./protocol";

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

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API — never `server.accept()`, which would pin the object in memory. The `userId` tag lets
    // the runtime hand this user's sockets back after eviction.
    this.ctx.acceptWebSocket(server, [userId]);
    // A tiny attachment (well under the 16,384-byte ceiling): the identity that survives hibernation.
    server.serializeAttachment({ userId });

    // The connect payload: this player's pending invites, plus which of their accepted friends are online now.
    const db = matchmakingDatabase(this.env.DB);
    const pendingInvites = await inviteStore(db).pendingFor(userId);
    const friends = await friendStore(db).list(userId);
    const accepted = new Set(friends.filter((edge) => edge.status === "accepted").map((edge) => edge.userId));
    const onlineFriends = this.connectedUserIds().filter((id) => accepted.has(id));
    server.send(JSON.stringify({ type: "init", pendingInvites, onlineFriends }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push an event to a connected user's sockets. A no-op if the user is offline. */
  async notify(userId: string, event: PresenceEvent): Promise<void> {
    const frame = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.socketUserId(ws) !== userId) continue;
      try {
        ws.send(frame);
      } catch {
        // A dead socket — skip it; the player resyncs on reconnect. One bad socket never blocks the rest.
      }
    }
  }

  /** The user ids currently connected — distinct, read back from each socket's attachment (hibernation-safe). */
  connectedUserIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.socketUserId(ws);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** Keepalive only — presence carries no client-authoritative state; a `ping` gets a `pong`, else no-op. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") {
      try {
        ws.send("pong");
      } catch {
        // Socket is closing — nothing to answer.
      }
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

  /** The authenticated user id stashed on a socket, or undefined for an unidentified one. */
  private socketUserId(ws: WebSocket): string | undefined {
    const attachment = ws.deserializeAttachment() as { userId?: string } | null;
    return attachment?.userId;
  }
}
