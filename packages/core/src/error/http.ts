// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { ErrorPayload, PublicErrorPayload } from "./payload";
import { InternalError, PithyError, ValidationError } from "./pithyError";

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
 * Hono's own 400s are the caller's fault, not ours. `hono/validator` throws `HTTPException(400)`
 * for a body it cannot even parse — a malformed JSON document, a malformed multipart form — before
 * any schema runs, so no validator hook ever sees it. Left alone it would fall through to the
 * generic wrap below and answer a bad request with a 500. Only 400 is translated: every other
 * `HTTPException` is a framework condition we have no public wording for, and guessing one would
 * put Hono's internal text on the wire.
 */
function fromHttpException(error: HTTPException): PithyError | null {
  if (error.status !== 400) return null;
  return new ValidationError({ message: "The request body could not be parsed.", detail: error.message });
}

/**
 * Hono `onError` handler. Register once on the root app (`app.onError(pithyErrorHandler)`): any
 * `PithyError` becomes `{ error: <public payload> }` at its declared status; a Hono `HTTPException`
 * 400 becomes `validation/invalid_input`; any other throw is wrapped as a `core/internal` 500
 * carrying the original as `cause` (kept internal) and a generic public message — mirroring the
 * CLI's "unexpected crash" path.
 */
export function pithyErrorHandler(err: Error, c: Context): Response {
  const translated = err instanceof HTTPException ? fromHttpException(err) : null;
  const pithy =
    err instanceof PithyError
      ? err
      : (translated ?? new InternalError({ detail: err instanceof Error ? err.message : String(err) }, { cause: err }));
  return c.json({ error: HttpError.encode(pithy.payload) }, pithy.payload.status);
}
