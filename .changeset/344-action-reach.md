---
"@pithy-sh/core": minor
"@pithy-sh/multiplayer": patch
---

Put the client boundary above the transports, and take `action` off the socket.

#344 classified `action` as the operator's and stripped it where the boundary was written: the HTTP codec. A Durable Object pushing an error frame down a player's WebSocket never touches that codec, and multiplayer's session object built its frame by hand — `{ code, message, action }`. So the remedy that was removed from every HTTP body was still going to the browser over a socket, and the rule read as satisfied because the rule was phrased in terms of one transport.

**`clientError` is now the one place an error becomes bytes for a client**, whatever the transport. `HttpError.encode` calls it. The multiplayer session's frames are built from a `PithyError` through it, and the frame builder takes nothing else — there is no hand-written shape left to disagree with the schema. What it strips is not a list this function maintains: both fields are removed by name and the result is parsed by `PublicErrorPayload`, which has neither key, so an adopter's own code is held to the same boundary as the kit's.

The census of every other transport that could serialise an error toward a browser, because the point of a fix at the thing is that the next one arrives already correct:

- **`@pithy-sh/matchmaking` presence socket** — sends presence frames and `pong`, and never an error payload; an upgrade it refuses answers with a fixed string and a status. Safe as written.
- **The DO ↔ Worker RPC envelopes** (multiplayer's `guard`, matchmaking's `guardRpc`) — carry the whole payload, `action` and `detail` included, deliberately: both ends are ours, and the route revives a real `PithyError` that then leaves through `clientError`. A malformed envelope propagates as a bare `Error` and lands in `detail`, which is stripped. Safe.
- **The HTML surfaces** (`@pithy-sh/testers` opt-in pages, `@pithy-sh/email` callback pages) — fixed copy, no payload rendered. **No SSE anywhere in the kit.** **No Workflow or queue consumer** returns an error to a client; failures go to logs, rows, and the audit trail, which are operator surfaces and keep `action` on purpose.

One thing found and left alone: `@pithy-sh/payments`'s browser client still reads `action` off an error body it can no longer receive, and surfaces it as `PaymentsFailure.action`. It resolves to `null` on every real response — dead, not leaky — but it tells a reader the wire has a field it does not.
