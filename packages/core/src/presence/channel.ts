// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SocketChannel } from "../http/socket";
import { type PresenceDeclaration, presenceSocketPath } from "./declaration";
import {
  PRESENCE_ROOM_VERSIONS,
  PresenceActivityFrame,
  PresenceJoinedFrame,
  PresenceLeftFrame,
  PresenceRoomErrorFrame,
  PresenceRoomInitFrame,
  PresenceRoomPing,
  PresenceRoomPong,
  PresenceSetActivityFrame,
} from "./frames";
import { PresenceRoomParams } from "./http/schemas";

/**
 * A capability's presence room socket, declared for the AsyncAPI contract. `defineCapability` adds it to the
 * capability's `sockets` whenever it declares room kinds, from the same `basePath` the routes mount on, so a
 * declared socket and a mounted one cannot be two different things.
 */
export function presenceRoomsSocket(capability: string, presence: PresenceDeclaration): SocketChannel {
  return {
    name: `${capability}PresenceRooms`,
    path: presenceSocketPath(presence.basePath),
    summary: `Who else has a ${capability} record open, and what they are doing, live.`,
    description: `Mint a ticket first — \`POST /control-plane/presence/tickets\` for a management client, \`POST ${presence.basePath}/presence/tickets\` for a signed-in user — then offer \`pithy.presence.v1\` and \`pithy.ticket.<ticket>\` in \`Sec-WebSocket-Protocol\`. The ticket is the credential: single use, 60 seconds, this room only. The room sends \`init\` first, then \`joined\`, \`left\` and \`activity\` as they happen. Send \`set_activity\` to announce one of the kind's declared activities, and \`ping\` as plain text to get \`pong\`. Room kinds: ${presence.rooms.map((room) => `\`${room.kind}\``).join(", ")}.`,
    verification: "public",
    params: PresenceRoomParams,
    versions: PRESENCE_ROOM_VERSIONS,
    send: [
      { name: "init", summary: "Everyone in the room, sent once on connect.", schema: PresenceRoomInitFrame },
      { name: "joined", summary: "Another participant joined.", schema: PresenceJoinedFrame },
      { name: "left", summary: "Another participant left, or their socket dropped.", schema: PresenceLeftFrame },
      { name: "activity", summary: "Another participant changed what they are doing.", schema: PresenceActivityFrame },
      { name: "error", summary: "A frame the room could not accept.", schema: PresenceRoomErrorFrame },
      { name: "pong", summary: "The answer to `ping`, as plain text.", text: PresenceRoomPong.value },
    ],
    receive: [
      { name: "set_activity", summary: "Announce a declared activity.", schema: PresenceSetActivityFrame },
      { name: "ping", summary: "The keepalive, as plain text.", text: PresenceRoomPing.value },
    ],
  };
}
