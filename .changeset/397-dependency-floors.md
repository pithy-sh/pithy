---
"@pithy-sh/support": patch
"@pithy-sh/email": patch
"@pithy-sh/cli": patch
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/core": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

Set the dependency floors the first release ships.

`bun audit` went from 24 advisories to 5. The `hono` floor moves to `^4.13.2`, clearing seven —
none reachable from the kit's own code, all reachable by an adopter composing `hono/cors` or
`hono/jsx` through our range. `nanoid`, `postcss`, `fast-uri` and `js-yaml` cleared with a
lockfile refresh.

`postal-mime` moves to `^3.0.0`, and it is a security bump rather than a version bump. 2.7.x
resolved a duplicated single-value header last-wins, so a sender could append a second `From:`
below their own headers and choose the address `@pithy-sh/support` recorded as the sender, while
every verdict above it was stamped against the topmost one. 3.0.0 resolves first-wins, which is the
rule the header map already applied.

Five undici advisories remain. Every `miniflare` 4.x pins `undici` at exactly `7.28.0`, so no
floor of ours can move them, and miniflare 5 is alpha-only. miniflare is the local simulator; it is
in no deployed Worker. `docs/STACK.md` §17 records that, and every other floor, with its reason.
