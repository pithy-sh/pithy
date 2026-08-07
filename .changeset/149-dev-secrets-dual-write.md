---
"@pithy-sh/cli": patch
---

A seeded dev secret is injected into `.dev.vars` as well, so a fresh project still resolves it.

`secretsStore` resolves **every** secret from its injected binding in dev, whatever its registry `backend` — only the deployed branch routes by backend. Moving `auth-session-secret` into the dev secrets file and the local `SECRETS` D1 therefore put it somewhere dev never reads: `pithy init` + `pithy add auth` + `pithy dev` answered `secrets/not_found` on the first sign-in, with the row sitting seeded and unread.

So both. The file is the source of truth, it is seeded into the store, and the value is also injected into `.dev.vars` as the encoded envelope — the shape the store holds, keeping every version rather than collapsing to the current one. `pithy add` carries a value it has just minted across itself, because a project that has not composed `secrets` yet has no registry for the seeder to consult.

This is a transition, not the design. #153 routes dev's read path by backend, collapses the two branches into one, and deletes the injection in the same commit.
