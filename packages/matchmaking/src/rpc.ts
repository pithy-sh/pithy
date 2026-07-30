// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";

/**
 * The Durable Object RPC error codec — the same shape multiplayer uses. A `PithyError` thrown inside a DO
 * is flattened to a bare `Error` across the RPC boundary (only its `message` survives), which would turn a
 * deliberate 404 into a 500. The DO encodes the payload into the message; the route decodes it back into a
 * real `PithyError` so its status and code are preserved.
 */
export const RPC_ERROR_PREFIX = "pithy-error:";

/** DO side: run a body, re-encoding any thrown `PithyError` into a message the boundary preserves. */
export async function guardRpc<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PithyError) throw new Error(RPC_ERROR_PREFIX + JSON.stringify(error.payload));
    throw error;
  }
}

/** Route side: run a DO call, decoding an encoded `PithyError` message back into a real `PithyError`. */
export async function callRpc<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PithyError) throw error;
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.startsWith(RPC_ERROR_PREFIX)) {
      try {
        const parsed = ErrorPayload.safeParse(JSON.parse(message.slice(RPC_ERROR_PREFIX.length)));
        if (parsed.success) throw new PithyError(parsed.data, { cause: error });
      } catch (reviveError) {
        if (reviveError instanceof PithyError) throw reviveError;
      }
    }
    throw error;
  }
}
