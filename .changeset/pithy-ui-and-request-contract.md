---
"@pithy-sh/leaderboard": minor
"@pithy-sh/matchmaking": minor
"@pithy-sh/multiplayer": minor
"@pithy-sh/turnstile": minor
"@pithy-sh/storage": minor
"@pithy-sh/wallet": minor
"@pithy-sh/rating": minor
"@pithy-sh/vector": minor
"@pithy-sh/email": minor
"@pithy-sh/media": minor
"@pithy-sh/auth": minor
"@pithy-sh/core": minor
"@pithy-sh/ui-react": minor
"@pithy-sh/vite": minor
"@pithy-sh/cli": minor
---

`pithy ui add react` scaffolds a React 19 front end into a Worker and wires it end to end — HMR against real bindings in dev, one origin in production, and passwordless sign-in already working when auth is composed. Every route Pithy provides now declares its params, query, and body on the route itself, validated by one mechanism.

Two edges change what a caller sees. Free-form params — `userId`, invite `id`, room `code`, media and session ids, email tokens — are now shape-checked and can answer 400 where they previously reached a store. And a validator on the route line runs before the handler, so a request that is both malformed and unresolvable now returns 400 where it used to return the domain's 404.

One more is a behaviour change worth knowing about: a **repeated** query parameter is now a 400 on any validated query. `?window=a&window=b` previously resolved to one value silently; `@hono/zod-validator`'s `query` target hands the schema an array, which a scalar field rejects.

Two more become correct rather than merely different. A body Hono cannot parse at all is now a 400 instead of a 500. And `turnstile()` reads the response token off a clone of the request, so a request that passes the humanity check still reaches the handler behind it — previously the gate consumed the body and only worked when it denied.
