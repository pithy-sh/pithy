---
"@pithy-sh/core": minor
"@pithy-sh/payments": patch
---

The Google rail verifies through `core/http/oidcWebhook`, and an anonymous flood buys one key fetch.

There were two OIDC verifiers in the kit — `payments/src/rails/google/oidc.ts` and the core module #518 generalized out of it — and they could drift. That is the shape of #501, #513 and #519, and it matters more here, because the thing that can drift is an authentication boundary.

The rail is now Google's specialization and nothing else: its issuers, its JWKS URL, its audience, and a claims predicate for the service-account pair it asserts. No JWT parsing, no JWKS fetching, no signature verification of its own. The reduction is not like-for-like — core was hardened past the original, so the rail gains `nbf`, a refusal of a non-finite skew or TTL rather than a silent fail-open, and an absurd `exp` that refuses instead of throwing a bare `RangeError` and turning a forgery into a 500.

**`resetGoogleJwksCache` is gone, and with it the module-global it existed to reach.** The store is now built once per composition and threaded to the rail, so two apps in one process do not share one — which is what the export was working around.

**The flood a public webhook actually attracts is answered, not the one that is easy to test.** A cache keyed on the issuer's URL answers a forger who copies a published `kid`; it does nothing about an invented one, because a `kid` miss is a refresh and the `kid` is attacker-chosen and unauthenticated. So a 49-byte token naming `kid: <uuid>` bought a round trip to the issuer, 1:1, until the issuer rate-limited us and genuine deliveries failed alongside the forgeries — with `core/upstream_failed` passing through to a 502 that Pub/Sub retries into the same path.

`JwksCache` now decides that: **`claimRefresh(url, seconds)` asks whether the endpoint may be consulted and records the answer in one act**, so a concurrent burst grants exactly one ask. `resolveKey` claims the window before fetching, so a failing issuer costs one attempt per window rather than one per delivery, and a miss inside the window is refused without an outbound request — 401 when keys are held, because the issuer does not publish that `kid`, and 502 when none are, because we genuinely could not look. Measured through the real route: 40 deliveries naming 40 invented `kid`s, one round trip.

The cost is stated rather than hidden: a genuinely new signing key can be refused for up to `OIDC_JWKS_MIN_REFRESH_SECONDS` (60), which is inside every issuer's rotation overlap, and a redelivery picks it up.

**A key that will not import is the sender's fault, not the issuer's.** A non-RSA `kty` and a failing `importKey` both refuse as unverified — 401, audited — rather than as upstream. The key is reached because an unverified header's `kid` selected it, so answering 502 would let an anonymous caller choose a pass-through code: out of the audit trail, and into indefinite retry.

**Breaking, for anyone implementing `JwksCache`**: the interface has a third required method. An implementation that only stores and returns keys must now also answer whether a refresh may happen; returning `true` unconditionally restores the old behavior and the old hazard with it.
