// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SocketChannel } from "@pithy-sh/core/src/http/socket";
import {
  PRESENCE_VERSIONS,
  PresenceClientFrame,
  PresenceErrorFrame,
  PresenceFriendRequestFrame,
  PresenceInitFrame,
  PresenceInviteFrame,
  PresenceMatchFoundFrame,
  PresencePong,
} from "./frames";

/** Where the presence socket mounts under the matchmaking routes. */
export const PRESENCE_PATH = "/presence";

/**
 * The presence socket, declared for the AsyncAPI contract. Built from the resolved base path, because that
 * is where `registerMatchmakingRoutes` mounted the upgrade route. Every schema here is the one the Durable
 * Object sends or parses with.
 */
export function presenceSocket(basePath = "/matchmaking"): SocketChannel {
  return {
    name: "matchmakingPresence",
    path: `${basePath}${PRESENCE_PATH}`,
    summary:
      "A player's presence: pending invites on connect, then invites, friend requests and matches as they happen.",
    description:
      "The Worker sends `init` first, then events as they happen. Send `ping` as plain text to get `pong`. On `pithy.presence.v1`, anything else is answered with an `error` frame; an unversioned socket ignores it.",
    verification: ["bearer", "session"],
    versions: PRESENCE_VERSIONS,
    send: [
      {
        name: "init",
        summary: "The player's pending invites and online friends, sent once on connect.",
        schema: PresenceInitFrame,
      },
      { name: "match_found", summary: "A match formed around the player.", schema: PresenceMatchFoundFrame },
      { name: "invite", summary: "Another player sent a direct invite.", schema: PresenceInviteFrame },
      { name: "friend_request", summary: "Another player sent a friend request.", schema: PresenceFriendRequestFrame },
      { name: "error", summary: "A frame the socket could not accept.", schema: PresenceErrorFrame },
      { name: "pong", summary: "The answer to `ping`, as plain text.", text: PresencePong.value },
    ],
    receive: [{ name: "ping", summary: "The keepalive, as plain text.", text: PresenceClientFrame.value }],
  };
}
