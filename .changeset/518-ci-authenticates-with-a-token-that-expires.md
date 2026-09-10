---
"@pithy-sh/core": minor
---

An OIDC verifier, for a webhook whose sender is a CI job rather than a payment rail.

`@pithy-sh/core/src/http/oidcWebhook` verifies a token an identity provider signed: signature first, then issuer, audience, expiry, and a `claims` predicate the caller supplies. It generalizes the hardened Google Play verifier rather than restating it — same four-step ordering, same refusal to read a claim before the signature is proven, and the same single 401 for every way a sender can fail, with the reason in `detail` where a forger cannot reach it.

What is new beside the original: `nbf` is honored, a non-finite clock skew or JWKS TTL is refused rather than silently disabling every freshness check, an absurd `exp` no longer throws a bare `RangeError` while composing its own refusal, and the JWKS cache is injected rather than a module global — so the reset function that existed only because the state was unreachable does not come with it.

Pithy's own release reporting is the first consumer. It authenticates to the dashboard with a GitHub-minted token scoped per destination, so a token for staging is not replayable against production, and no shared secret exists on either side.
