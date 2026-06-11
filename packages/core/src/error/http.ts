import type { Context } from "hono";
import { z } from "zod";
import { ErrorPayload, PublicErrorPayload } from "./payload";
import { InternalError, PithyError } from "./pithyError";

/**
 * The HTTP surface of an error, as a real codec. `encode` (server emits) maps an in-memory
 * `ErrorPayload` down to the public wire shape — **this is the security boundary: it drops
 * `detail`, so internal context can never land in an HTTP body.** `decode` (client SDK parses)
 * maps a wire body back to a payload. The one schema validates both directions, so the error a
 * server sends and the error an app receives are the same contract.
 */
export const HttpError = z.codec(PublicErrorPayload, ErrorPayload, {
  decode: (wire): ErrorPayload => wire,
  encode: (payload): PublicErrorPayload => {
    const { detail: _detail, ...wire } = payload;
    return wire;
  },
});

/**
 * Hono `onError` handler. Register once on the root app (`app.onError(pithyErrorHandler)`): any
 * `PithyError` becomes `{ error: <public payload> }` at its declared status; any other throw is
 * wrapped as a `core/internal` 500 carrying the original as `cause` (kept internal) and a generic
 * public message — mirroring the CLI's "unexpected crash" path.
 */
export function pithyErrorHandler(err: Error, c: Context): Response {
  const pithy =
    err instanceof PithyError
      ? err
      : new InternalError({ detail: err instanceof Error ? err.message : String(err) }, { cause: err });
  return c.json({ error: HttpError.encode(pithy.payload) }, pithy.payload.status);
}
