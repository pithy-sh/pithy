// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { SocketVersions } from "./subprotocol";
import type { VerificationStrategy } from "./verification";

/**
 * **A WebSocket, described for the AsyncAPI contract.** The socket's counterpart of `describeRoute`.
 *
 * OpenAPI cannot describe a socket: after the upgrade there are no requests, only frames each way. So a
 * capability that serves one declares it on its `sockets` contribution, built from its resolved config —
 * the path it mounted, how a caller is verified, the versions it serves, and a Zod schema for every frame
 * each side may send. `../asyncapi/document.ts` reads the declarations into an AsyncAPI document, the way
 * `../openapi/document.ts` reads the route table into OpenAPI.
 *
 * The schemas are the ones the socket parses with, never a copy: a frame the Worker receives is parsed with
 * the schema declared here, so the document and the socket cannot disagree about what is accepted.
 */

/** One frame one side of a socket may send. */
export interface SocketMessage {
  /** The frame's name, unique within its socket: `state`, `error`, `action`. */
  readonly name: string;
  /** What the frame is, in one sentence. */
  readonly summary: string;
  /** The frame's JSON body. Absent for a plain-text frame. */
  readonly schema?: z.ZodType;
  /** A plain-text frame's exact text — `ping`, `pong`. The one exception to JSON frames, stated per frame. */
  readonly text?: string;
}

/** One WebSocket a capability serves. */
export interface SocketChannel {
  /** A stable name for the socket, unique in the Worker: `multiplayerSession`, `matchmakingPresence`. */
  readonly name: string;
  /** The upgrade path, as Hono registered it: `/multiplayer/sessions/:id/socket`. */
  readonly path: string;
  /** What the socket is for, in one sentence. */
  readonly summary: string;
  /** Anything a client author must know that the schemas do not say. */
  readonly description?: string;
  /** How the upgrade request is verified. */
  readonly verification: VerificationStrategy | readonly VerificationStrategy[];
  /** The path parameters' schema — the same one the upgrade route validates them with. */
  readonly params?: z.ZodType;
  /** The subprotocol versions this socket serves. */
  readonly versions: SocketVersions;
  /** Every frame the Worker sends. */
  readonly send: readonly SocketMessage[];
  /** Every frame the Worker accepts. Anything else is answered with a `validation/invalid_input` error frame. */
  readonly receive: readonly SocketMessage[];
  /** Further named schemas a client needs, such as each configured game's `action` and `view`. */
  readonly schemas?: Readonly<Record<string, z.ZodType>>;
}
