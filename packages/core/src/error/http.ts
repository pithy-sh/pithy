// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { clientError } from "./client";
import { ErrorPayload, PublicErrorPayload } from "./payload";
import { InternalError, PithyError, ValidationError } from "./pithyError";

/**
 * The HTTP surface of an error, as a real codec. `encode` (server emits) maps an in-memory
 * `ErrorPayload` down to the public wire shape by calling {@link clientError} — **the security
 * boundary, which drops `action` and `detail`, so neither an operator's remedy nor internal context
 * can land in an HTTP body.** `decode` (client SDK parses) maps a wire body back to a payload. The one
 * schema validates both directions, so the error a server sends and the error an app receives are the
 * same contract.
 *
 * **`action` is stripped because it is written for an operator, not for a caller.** It names `pithy`
 * commands, files in the adopter's repository, wrangler bindings and provider consoles — a
 * description of the deployment, handed out at whatever status the error carries. The operator reads
 * it on the surfaces built for them: the terminal, the CLI's `--json` line, a log, an audit row. What
 * the caller gets is `message`, which is the field that has always meant "safe to expose".
 *
 * **The rule is not kept here.** HTTP is one transport of several — a WebSocket frame is a client
 * surface that never touches this codec — so the projection lives in ./client and this encoder is one
 * of its callers. Doing it the other way round is what let an `action` reach a browser over a socket.
 */
export const HttpError = z.codec(PublicErrorPayload, ErrorPayload, {
  decode: (wire): ErrorPayload => wire,
  encode: (payload): PublicErrorPayload => clientError(payload),
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
  // A kit member pins a literal status; an adopter's carries a `number` the schema has already
  // bounded to 400–599. Hono types the argument as its own literal union, and that is the one gap
  // between the two — the value is validated, so the assertion narrows rather than trusts.
  return c.json({ error: HttpError.encode(pithy.payload) }, pithy.payload.status as ContentfulStatusCode);
}
