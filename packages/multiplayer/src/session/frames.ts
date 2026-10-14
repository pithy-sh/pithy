// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ErrorBody } from "@pithy-sh/core/src/error/wire";
import type { SocketVersions } from "@pithy-sh/core/src/http/subprotocol";
import { z } from "zod";
import { SessionView } from "./view";

/**
 * **Every frame on a session's socket, as a Zod schema.** The socket's counterpart of `http/responses.ts`.
 *
 * The session socket (`GET /multiplayer/sessions/:id/socket`) carries JSON text frames each way. What the
 * Worker sends is {@link ServerFrame}; what it accepts is {@link ClientFrame}. Both are discriminated on
 * `type`, and the Durable Object parses every frame it receives with {@link ClientFrame}. A frame that is not
 * JSON is answered with an `error` frame carrying `validation/invalid_input`, and the socket stays open. On a
 * `pithy.multiplayer.v1` socket, so is a frame that names a `type` it does not know, names none, or carries a
 * bad field. An unversioned socket ignores such a frame silently, as it always did.
 *
 * **Versioning** follows the one rule in `docs/SOCKETS.md`: an added field is optional, a client ignores what it
 * does not know, and a change no client could ignore is a new subprotocol the Worker serves beside the last.
 *
 * A game's own shapes ride inside these frames: an `action` frame's `payload` is the game model's `action`,
 * and a `state` frame's `state` is its `view`. Each configured game's pair is published beside the frames in
 * the Worker's AsyncAPI document, keyed `<gameKey>.action` and `<gameKey>.view`.
 *
 * Pure, and kept that way: zod and core's leaf modules only, never `cloudflare:workers` or Hono, because a
 * browser and an engine's client import it — the same rule `./protocol.ts` follows (#172).
 */

/** The subprotocols the session socket serves: `pithy.multiplayer.v1`, and the unversioned one before it. */
export const MULTIPLAYER_SOCKET_VERSIONS = {
  current: "pithy.multiplayer.v1",
  previous: null,
} as const satisfies SocketVersions;

/** The caller's view of the session — sent on connect, after every change, and on a `state` request. */
export const StateFrame = SessionView.extend({
  type: z.literal("state").describe("Always `state`."),
}).describe(
  "The caller's view of the session. Sent on connect, after every change to the session, and in answer to a `state` frame.",
);
export type StateFrame = z.infer<typeof StateFrame>;

/** Something the caller sent was refused, or failed. The socket stays open. */
export const ErrorFrame = z
  .object({
    type: z.literal("error").describe("Always `error`."),
    error: ErrorBody.shape.error,
  })
  .describe(
    "A refusal or failure, as the same public error payload an HTTP error body carries. The socket stays open.",
  );
export type ErrorFrame = z.infer<typeof ErrorFrame>;

/** Every frame the Worker sends a `pithy.multiplayer.v1` client. */
export const ServerFrame = z
  .discriminatedUnion("type", [StateFrame, ErrorFrame])
  .describe("A frame the Worker sends on the session socket. A client ignores a `type` it does not know.");
export type ServerFrame = z.infer<typeof ServerFrame>;

/** Take an action in the game. */
export const ActionFrame = z
  .object({
    type: z.literal("action").describe("Always `action`."),
    payload: z
      .unknown()
      .optional()
      .describe(
        "The action itself, in the shape the game's model defines — its `<gameKey>.action` schema. Parsed with that schema before the move is judged. Absent reaches the game as no payload.",
      ),
  })
  .describe("Take an action in the game. Answered by a `state` frame to every member, or an `error` frame.");
export type ActionFrame = z.infer<typeof ActionFrame>;

/** Ask for the current state again. */
export const StateRequestFrame = z
  .object({
    type: z.literal("state").describe("Always `state`."),
  })
  .describe("Ask for the caller's view again, to resync. Answered by a `state` frame.");
export type StateRequestFrame = z.infer<typeof StateRequestFrame>;

/** Every frame the Worker accepts, whichever version the socket speaks. */
export const ClientFrame = z
  .discriminatedUnion("type", [ActionFrame, StateRequestFrame])
  .describe(
    "A frame a client sends on the session socket. Anything else is answered with an `error` frame on `pithy.multiplayer.v1`, and ignored on the unversioned protocol.",
  );
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * The state frame for a socket speaking `protocol`, as the text the Worker sends: a typed {@link StateFrame}
 * for `pithy.multiplayer.v1`, and the bare view with no `type` for an unversioned client (`null`).
 */
export function encodeStateFrame(view: SessionView, protocol: string | null): string {
  if (protocol === null) return JSON.stringify(view);
  return JSON.stringify({ type: "state", ...view } satisfies StateFrame);
}

/**
 * An error frame, as the text the Worker sends. Takes the error already projected for a client — the caller
 * passes it through core's `clientError`, the one boundary an error crosses toward a client (#344). The same
 * frame for every version: it carried `type: "error"` before versions existed.
 */
export function encodeErrorFrame(error: ErrorFrame["error"]): string {
  return JSON.stringify({ type: "error", error } satisfies ErrorFrame);
}
