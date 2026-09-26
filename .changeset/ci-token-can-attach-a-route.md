---
"@pithy-sh/cloudflare": patch
"@pithy-sh/cli": patch
---

`pithy token mint ci-system` now scopes the CI token to the zones the project's declared domains sit in, so a CI deploy of a custom domain works.

It could not. `pithy deploy --env staging` of a Worker with a declared domain ends in `POST /zones/<zone>/workers/routes`, and the permission catalog's only zone entry was `zone:read`. The minted token had no group that could attach a route, so the deploy failed with `No access to the specified resource` — the one credential the kit tells an adopter to put in CI could not deploy any environment with a domain.

The group is zone-scoped, and a minted token's resources are account-scoped, so the account resource alone grants it nothing. The token now carries a **second** policy: Workers Routes Write on exactly the zones the project's `domains` name, never account-wide, never every zone on the account, and never a group that can alter a zone. The zones resolve against the account at mint time, by name, from the declaration — and a zone the account does not hold **fails the mint**, naming the domain and the zone, rather than minting a credential that passes every local check and fails in CI.

A project that declares no domain mints exactly what it minted before, and makes no extra call to do it.

Re-minting an existing token now **re-scopes it in place**. `rollToken` replaces the token's policies (`PUT /accounts/<id>/tokens/<id>`, where `policies` is a required field and therefore a replacement) and then rolls its value — scope first, so a failed re-scope costs nothing, where a value handed over before the scope lands is a credential that looks new and cannot deploy. Without this the remedy for the above could not perform the remedy: the roll regenerated the secret and discarded the permissions, so `pithy token mint ci-system` on an existing token printed `Done.` and changed nothing. It also makes the profile contract true in the other direction — a capability removed from a project now takes its `ciPermissions` off the credential on the next mint.

That update is a **full representation**, so everything else the token carries goes back with it: a hand-set `expires_on`, `not_before` or IP `condition`, and a `disabled` status. Sending only the policies would clear the hardening Cloudflare's own docs recommend and re-enable a token somebody had switched off. The values come off the record the mint already read, so preserving them costs no extra call.

Because the mint now replaces, **`--permission` on a token that already exists is refused**: the flag would not narrow one run, it would permanently re-scope the credential CI deploys with. The refusal names the three ways to say what was meant — drop the flag, pin it in `tokens.overrides`, or `pithy token rotate`. A profile with no token yet still mints narrowed.

`ensureManagerToken` stays on a value-only roll (`rollTokenKeepingPolicies`). The secrets manager's runtime credential belongs to a deployed Worker that is already reading secrets under the scope it was given, and that call sits in a contention loop that may roll five times.

`pithy token list` now reports whether a live CI token carries the zones this environment needs, and names the remedy. A token's own policies are the record: reading the token record needs a grant these least-privilege tokens deliberately lack, so the account's token list is the only place the answer exists. Coverage is read from the policy's **permission group, its resources and its effect together** — a zone-scoped read on the right zone is not a route grant, and an explicit `deny` naming the route group is the opposite of one — across both the flat and the nested-in-account resource forms Cloudflare writes. A zone the token names nowhere is decisively uncovered whatever its groups say; only a zone that *is* named can be unknowable. A zone or group lookup that fails reports `unknown` rather than taking the listing down.

A grant missing because a standing `tokens.overrides` removes it reads as its own state, and the notice names the override instead of a re-mint — re-minting honors the override, so printing that command would be a loop that never ends.

An explicit `--permission`, or a `tokens.overrides` entry, now means exactly what it says: the route policy rides with the profile's default permission set and is not added to a credential somebody narrowed by hand.

A zone that cannot be scoped fails the mint in all three of its ways, not one: absent from the account, duplicated on it, or not yet active. And a 403 on a mint carrying a zone policy now names the grant the caller must itself hold, since Cloudflare only lets a token create a token whose permissions it has — telling an operator to grant "Account API Tokens Write" when they already have it is the least useful true sentence available.

A live-account suite mints both shapes — the token as it was and the token as it is — and points each at the two calls a declared-domain deploy makes: the zone route read and write, and `PUT /accounts/<id>/workers/domains`. That second call is addressed to an account path and still needs the **zone's** `Workers Routes Write`, per Cloudflare's [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) — so the old shape is asserted refused on both. Its teardown runs unconditionally, finds what it deletes, polls through a list that has not caught up, and names on stderr anything it could not delete or could not confirm gone. Gated on the new `workers-route-zone` fixture.
