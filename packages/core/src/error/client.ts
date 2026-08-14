// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { ErrorPayload } from "./payload";
import { PublicErrorPayload } from "./payload";

/**
 * **The one place an error becomes bytes for a client.** Whatever the transport.
 *
 * An error leaves this process by more than one road. A JSON response is the busiest, and it had the
 * boundary written into it — but a Durable Object also pushes error frames down a WebSocket, and a
 * transport that grew its own projection grew its own idea of what a client may read. That is how
 * `action` reached a browser after the schema had already classified it: not because anyone disagreed
 * with the rule, but because the rule lived inside the HTTP codec, and a socket is not HTTP.
 *
 * So the rule sits here, above every transport, and each transport calls it:
 *
 * - `HttpError.encode` (./http) — the JSON body of a response.
 * - The multiplayer session Durable Object — the `error` frame on a player's socket.
 * - Anything added next. An SSE `event:`, a queue consumer echoing a failure, a Workflow surfacing one.
 *   None of them needs to know *what* is stripped; they need to know they must come through here.
 *
 * What it strips, and why that is not a list to maintain: `action` and `detail` are removed by name,
 * and the result is then parsed by `PublicErrorPayload`, which has neither key. The parse is what makes
 * the boundary hold for an **adopter's** code as well as the kit's — it is a property of the schema, so
 * a field classified as operator-facing tomorrow is stripped here without this function changing.
 *
 * The mirror is {@link operatorError} in ./terminal, which keeps `action` because whoever ran the
 * command is the person who can act on "Bind a D1 database named DB in wrangler.jsonc". Two audiences,
 * two functions, and neither one is a transport.
 *
 * It takes the **input** side of `ErrorPayload` rather than the output side, which is the wider of the
 * two: an adopter's code carries a brand once parsed, and a codec's encode side is handed the shape
 * before that brand exists. A `PithyError`'s own payload satisfies it either way, and the brand is not
 * something this function needs — it parses what it is given.
 */
export function clientError(payload: z.input<typeof ErrorPayload>): PublicErrorPayload {
  // Removed by name first, then by schema. Doubled deliberately: the spread states the intent at the
  // one site that has it, and the parse is what an adopter's own code is held to.
  const { action: _action, detail: _detail, ...wire } = payload;
  return PublicErrorPayload.parse(wire);
}
