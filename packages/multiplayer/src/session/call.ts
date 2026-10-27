// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { RPC_ERROR_PREFIX } from "./protocol";

/**
 * Run a Durable Object RPC call, reviving a `PithyError` the DO threw.
 *
 * A `PithyError` thrown inside a DO does not cross the RPC boundary as itself — the runtime strips it to a
 * bare Error. So the DO's `guard` encodes the payload as JSON into the Error message behind
 * {@link RPC_ERROR_PREFIX} (a message is the one thing the boundary preserves), and this decodes it back
 * into a real `PithyError` so `pithyErrorHandler` maps it to the same status and body a direct throw would
 * — a `not_a_member` commit stays a 403, not a 500. Anything else propagates untouched (and 500s, correctly).
 */
export async function callSession<T>(run: () => Promise<T>): Promise<T> {
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
        // A revived PithyError is the intended result — rethrow it. Only a genuinely malformed envelope
        // (JSON.parse failure) falls through to the original error below, rather than a 500 from here.
        if (reviveError instanceof PithyError) throw reviveError;
      }
    }
    throw error;
  }
}
