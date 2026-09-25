---
"@pithy-sh/cloudflare": patch
"@pithy-sh/cli": patch
---

`pithy token mint ci-system` now scopes the CI token to the zones the project's declared domains sit in, so a CI deploy of a custom domain works.

It could not. `pithy deploy --env staging` of a Worker with a declared domain ends in `POST /zones/<zone>/workers/routes`, and the permission catalog's only zone entry was `zone:read`. The minted token had no group that could attach a route, so the deploy failed with `No access to the specified resource` — the one credential the kit tells an adopter to put in CI could not deploy any environment with a domain.

The group is zone-scoped, and a minted token's resources are account-scoped, so the account resource alone grants it nothing. The token now carries a **second** policy: Workers Routes Write on exactly the zones the project's `domains` name, never account-wide, never every zone on the account, and never a group that can alter a zone. The zones resolve against the account at mint time, by name, from the declaration — and a zone the account does not hold **fails the mint**, naming the domain and the zone, rather than minting a credential that passes every local check and fails in CI.

A project that declares no domain mints exactly what it minted before, and makes no extra call to do it.

`pithy token list` now reports whether a live CI token carries the zones this environment needs, and names the one command that re-mints it. A token's own policies are the record: reading the token record needs a grant these least-privilege tokens deliberately lack, so the account's token list is the only place the answer exists.

A live-account suite mints both shapes — the token as it was and the token as it is — and points each at a real route write. Gated on the new `workers-route-zone` fixture.
