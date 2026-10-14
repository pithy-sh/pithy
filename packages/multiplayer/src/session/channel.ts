// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SocketChannel } from "@pithy-sh/core/src/http/socket";
import type { z } from "zod";
import type { ResolvedGame } from "../config/config";
import { resolveModel } from "../game/model";
import { MultiplayerSessionParams } from "../http/schemas";
import { ActionFrame, ErrorFrame, MULTIPLAYER_SOCKET_VERSIONS, StateFrame, StateRequestFrame } from "./frames";
import { SessionView } from "./view";

/** The session socket's stable name in the AsyncAPI document. */
export const MULTIPLAYER_SOCKET_NAME = "multiplayerSession";

/** Where the upgrade route mounts the session socket, under the capability's base path. */
export function multiplayerSocketPath(basePath = "/multiplayer"): string {
  return `${basePath}/sessions/:id/socket`;
}

/**
 * Each configured game's `action` and `view` schemas, keyed `<gameKey>.action` and `<gameKey>.view` — the
 * part of the socket that is the game. A model that declares neither contributes nothing, and a client reads
 * that game's payload and state as unknown, as it always has.
 */
export function gameSchemas(games: readonly ResolvedGame[]): Record<string, z.ZodType> {
  const schemas: Record<string, z.ZodType> = {};
  for (const game of games) {
    const model = resolveModel(game.kind);
    if (model?.action) schemas[`${game.key}.action`] = model.action;
    if (model?.view) schemas[`${game.key}.view`] = model.view;
  }
  return schemas;
}

/**
 * The session socket, declared for the AsyncAPI contract from the resolved config: the path the routes
 * mounted, the frames it parses with (`./frames.ts`), and every configured game's own schemas — an
 * adopter's games included, since they are configured the same way.
 */
export function multiplayerSocketChannel(games: readonly ResolvedGame[], basePath?: string): SocketChannel {
  return {
    name: MULTIPLAYER_SOCKET_NAME,
    path: multiplayerSocketPath(basePath),
    summary: "Play a session live: the caller's view on every change, and actions as frames.",
    description:
      "Only a member of the session may connect. Offer `pithy.multiplayer.v1` in `Sec-WebSocket-Protocol` to receive typed frames; a client that offers no subprotocol is sent the unversioned `snapshot` frame — the bare view, with no `type` — in place of `state`. An offer of anything else is refused with a 400 before the upgrade. A frame's `state` is the game's `<gameKey>.view` and an `action` frame's `payload` is its `<gameKey>.action`, where the game declares them. A client ignores a `type` and a key it does not know.",
    verification: ["bearer", "session"],
    params: MultiplayerSessionParams,
    versions: MULTIPLAYER_SOCKET_VERSIONS,
    send: [
      {
        name: "state",
        summary: "The caller's view of the session, on connect and after every change.",
        schema: StateFrame,
      },
      {
        name: "error",
        summary: "A refused or failed frame. The socket stays open.",
        schema: ErrorFrame,
      },
      {
        name: "snapshot",
        summary:
          "The unversioned protocol's state frame: the bare view, with no `type`. Sent only to a client that offered no subprotocol.",
        schema: SessionView,
      },
    ],
    receive: [
      { name: "action", summary: "Take an action in the game.", schema: ActionFrame },
      { name: "state", summary: "Ask for the caller's view again.", schema: StateRequestFrame },
    ],
    schemas: gameSchemas(games),
  };
}
