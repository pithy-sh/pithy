---
"@pithy-sh/core": patch
---

The identity provider's half of an OIDC webhook ships as test utilities, so an adopter proves their route instead of rebuilding the kit's fixtures.

`requireOidcWebhook` could not be tested by the project that mounts it without first re-deriving what `packages/core/src/http/oidcWebhook.test.ts` already had privately: WebCrypto key generation, base64url without padding, a compact JWS signed `RS256`, a transport that publishes the public half, and a second key so *signed by somebody else* is a real statement rather than a label. That came to 103 lines the first time, none of it adopter-specific — it is the provider's side of a protocol the kit implements.

The cost is not the typing. **A hand-rolled fixture is a second definition of the wire format, and it can agree with itself while disagreeing with the verifier it exists to exercise** — the same argument the kit already makes about signers. It bit on the first attempt: the copy's fake transport returned `json()` where `OidcJwksResponse` declares `text()` — deliberately text, so a proxy's HTML error page is a diagnosis rather than a throw — and every delivery 502'd from a fixture that looked correct.

`@pithy-sh/core/src/test-utils/oidcFixtures` now exports `mintKey`, `signToken`, `base64Url` and `publishing`, alongside the `MintedKey` a suite holds in a `beforeAll`. Two of the four shapes are load-bearing. `publishing` is typed as `OidcJwksFetch`, so the `json()` mistake is a red build rather than a wrong answer at runtime, and it takes the JWKS **url** rather than serving keys everywhere — a wildcard transport passes a route whose configured `jwksUrl` is a typo, which is the one configuration mistake a webhook route's test is there to catch. `signToken`'s `header` override is exported rather than hidden because it is what lets a route prove *itself* against `alg: "none"`, `alg: "RS512"` and an unpublished `kid`, instead of trusting that the kit covers it somewhere.

Two things are deliberately absent: a helper that builds a *provider's* claims, which differs per provider and is the adopter's to write, and the algorithm-confusion forgery, which proves a property of the kit's verifier rather than of an adopter's route. Both stay in the kit's own suite.

**The verifier's suite is the first consumer** — it imports the same four functions rather than keeping a copy, so there is one definition. And `oidcFixtures.test.ts` holds that definition to the real `verifyOidcToken`: a token these helpers mint, sign and publish is accepted, and a token they spoil is refused for the reason it was spoiled — an unpublished `kid`, a real signature under a published one, claims swapped after signing, another audience, another issuer, expiry, a rejected subject, each header override, and a JWKS url that answers 404. Acceptance alone would pass for a verifier that accepts everything and the refusals alone would pass for helpers that emit garbage; together they are what stops the fixture and the verifier drifting apart while both stay green.

Precedent and shape follow `@pithy-sh/secrets/src/test-utils/secretFixtures.ts`: a `src/test-utils/` module, deep-imported like any other, shipped in the package rather than copied into each consumer.
