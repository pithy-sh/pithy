---
"@pithy-sh/core": minor
---

Open the error taxonomy, and give it a word for someone else's outage.

`core/upstream_failed` (502) and `core/upstream_timeout` (504) name a dependency this service does not control — the case a proxy or a control plane hits constantly, and until now had to report as `core/internal`, a 500 that blames the wrong system. `UpstreamError` and `UpstreamTimeoutError` throw them.

`ErrorPayload` is no longer closed. It is the kit's union plus one open member, so an adopter can throw `connect/device_code_expired` or `keys/rotation_locked` under their own domain through `defineErrorPayload`. The kit's own set stays closed as `KitErrorPayload` / `KitErrorCode` — switch exhaustively over that, never over `ErrorCode`.

The kit's domains are reserved, like its table prefix: `auth/`, `payments/`, `core/` and the rest are refused — at the declaration, as a type error, and again at the parse. So a capability's typo stays a hard failure and the kit can add codes under its own domains without landing on an adopter's. And the HTTP codec strips `detail` from an adopter's error exactly as it does from the kit's. That boundary does not move.

Narrow with `isErrorCode(payload, "connect/device_code_expired")`, and type a vehicle class with `ErrorPayloadOf<"connect/device_code_expired">`. An adopter's code is branded — that brand is what keeps `payload.code === "core/not_found"` narrowing to exactly one kit member — and the cost is that a bare `===` against an adopter's own literal does not compile. These two are the way in for both halves.

**Two type changes to expect on upgrade.** `ErrorPayload` and `PublicErrorPayload` are a `z.union`, not a `z.discriminatedUnion`, so anything holding them as the latter moves to `KitErrorPayload`. And `payload.status` widens from a literal union to `number`, because an adopter's status is bounded (400–599) rather than pinned: code passing it straight to Hono — `c.json(body, err.payload.status)` — now wants `as ContentfulStatusCode`, which is what `pithyErrorHandler` does internally. Anyone on `pithyErrorHandler` is unaffected.
