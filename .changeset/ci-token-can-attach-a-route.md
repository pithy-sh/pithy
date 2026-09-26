---
"@pithy-sh/cloudflare": patch
"@pithy-sh/cli": patch
---

`pithy token mint ci-system` now scopes the CI token to the zones the project's declared domains sit in, so a CI deploy of a custom domain works.

It could not. `pithy deploy --env staging` of a Worker with a declared domain ends in `POST /zones/<zone>/workers/routes`, and the permission catalog's only zone entry was `zone:read`. The minted token had no group that could attach a route, so the deploy failed with `No access to the specified resource` — the one credential the kit tells an adopter to put in CI could not deploy any environment with a domain.

The group is zone-scoped, and a minted token's resources are account-scoped, so the account resource alone grants it nothing. The token now carries a **second** policy: Workers Routes Write on exactly the zones the project's `domains` name, never account-wide, never every zone on the account, and never a group that can alter a zone. The zones resolve against the account at mint time, by name, from the declaration — and a zone the account does not hold **fails the mint**, naming the domain and the zone, rather than minting a credential that passes every local check and fails in CI.

A project that declares no domain mints exactly what it minted before, and makes no extra call to do it.

Re-minting an existing token now **re-scopes it in place**. `rollToken` replaces the token's policies (`PUT /accounts/<id>/tokens/<id>`, where `policies` is a required field and therefore a replacement) and then rolls its value — scope first, so a failed re-scope costs nothing, where a value handed over before the scope lands is a credential that looks new and cannot deploy. Without this the remedy for the above could not perform the remedy: the roll regenerated the secret and discarded the permissions, so `pithy token mint ci-system` on an existing token printed `Done.` and changed nothing. It also makes the profile contract true in the other direction — a capability removed from a project now takes its `ciPermissions` off the credential on the next mint.

`pithy token list` now reports whether a live CI token carries the zones this environment needs, and names the one command that re-mints it. A token's own policies are the record: reading the token record needs a grant these least-privilege tokens deliberately lack, so the account's token list is the only place the answer exists. Coverage is read from the policy's **permission group and its resources together** — a zone-scoped read on the right zone is not a route grant — and a zone lookup that fails reports `unknown` rather than taking the listing down, so the command still answers what a listing is for.

An explicit `--permission`, or a `tokens.overrides` entry, now means exactly what it says: the route policy rides with the profile's default permission set and is not added to a credential somebody narrowed by hand.

A zone that cannot be scoped fails the mint in all three of its ways, not one: absent from the account, duplicated on it, or not yet active. And a 403 on a mint carrying a zone policy now names the grant the caller must itself hold, since Cloudflare only lets a token create a token whose permissions it has — telling an operator to grant "Account API Tokens Write" when they already have it is the least useful true sentence available.

A live-account suite mints both shapes — the token as it was and the token as it is — and points each at the two calls a declared-domain deploy makes: the zone-scoped route read and write, and the account-scoped `PUT /accounts/<id>/workers/domains` that attaches the custom domain. That second one runs on `Workers Scripts Write`, which `ci-system` has always carried, so it is stated plainly here: the zone grant is what unblocks the reported failure, and the domain write was never the missing piece. Gated on the new `workers-route-zone` fixture.
