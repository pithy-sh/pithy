---
"@pithy-sh/turnstile": minor
"@pithy-sh/core": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/cli": minor
---

New package: `@pithy-sh/turnstile` — stackable humanity-check middleware plus automated CF widget provisioning, with test keys wired automatically in dev and staging. Core drops `turnstile` from the `VerificationStrategy` union (it is composable middleware, not an identity strategy), adds the `turnstile/*` error codes, and gains a `dependsOn` peer-capability seam enforced at `createBackend` assembly. `@pithy-sh/cloudflare` Turnstile widget creation takes a mode (managed/invisible); the `pithy turnstile` command provisions and tears down widgets.
