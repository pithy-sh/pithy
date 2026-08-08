---
"@pithy-sh/cli": patch
"@pithy-sh/auth": patch
---

`pithy seed` reads the secret it just seeded.

A prepared seed set asks the CLI for a secret. That reader still opened the project's `.dev.vars` —
the file #153 emptied of every `d1` secret and #154 turned into a generated per-Worker artifact. So
`pithy seed` on any project composing auth's dev-session seed printed two lines that contradicted each
other:

```
Seeded auth-session-secret and email-link-signing-key into the local secrets store.
Cannot mint a dev session without this environment's auth secret.
Add auth-session-secret to .dev.vars, then seed again.
```

The secret was seeded. The seed that needs it could not see it. And the advice was to undo #153 — a
`d1` value in `.dev.vars` is inert, so following it produced the same failure a second time.

The reader now reads the dev secrets file, `<config>/<project>/secrets.jsonc`: the same source the run
had minted into two steps earlier, and the only place a dev value is *stated*. It needs no D1 and no
master key, so it answers where seeds run. There is no `.dev.vars` fallback and no backend branch,
because there is no second source — a `cf-secrets-store` line in a Worker's `.dev.vars` is generated
from this file, and a run-wide reader cannot say which Worker's copy it should trust anyway. What is
given up is narrow and deliberate: a value supplied only through a hand-written `.dev.vars.local`
override is not visible to a prepared set.

The value goes through the registry and the same conversion that fills the store, so a prepared set is
handed exactly the bytes the running Worker will resolve — a `text` secret that is not a string is
refused by name rather than stringified. A name no capability declares reads as absent, because the
Worker could not resolve it either. #159's environment gate is untouched: outside `dev` the reading
closure is never built.

Auth's message names the dev secrets file now. It does not guess the path — that set runs inside a
Worker with no filesystem, and `pithy doctor` prints the resolved path on every run.

The suite missed all of this because the dev-session seed's tests supply the secret through the
`secret` seam, so the seam was exercised and the thing behind it never was. The new test composes the
real seed against a project whose secret is in the new location and resolves it through the real
reader.

Fixes #176.
