---
"@pithy-sh/core": patch
"@pithy-sh/secrets": patch
"@pithy-sh/payments": patch
---

A constant a browser-facing schema quotes lives in a module that imports nothing.

Two numbers and one string moved, for one reason. `SIGNED_WEBHOOK_MAX_TOLERANCE_SECONDS` was exported from `core/src/http/signedWebhook.ts` — a Hono middleware, which reaches `PithyHonoEnv` and from there the whole Worker graph. `payments/src/config/config.ts` interpolates that number into a `.describe()`, so importing it pulled `hono`, `kysely`, `kysely-d1` and `@cloudflare/workers-types` into `payments/src/http/schemas.ts` and `responses.ts` — the two halves of a route contract a management client validates **in a browser**, where none of those exist. `MASTER_KEY_BINDING` did the same one package over: `secrets/src/registry.ts` reached it in `env/bindings.ts`, which declares the `D1Database` the binding resolves to, and `secrets/src/http/responses.ts` reaches the registry.

Both are leaves now — `core/src/http/webhookWindow.ts` and `secrets/src/env/masterKeyBinding.ts` — and **nothing in either may import anything**. That is the whole rule, and it is what makes the constant importable from a request schema, a config schema, a verifier and a Worker alike. Import from the new path: the old modules import these values, they do not re-export them.

`tooling/browser-scopes` is what caught it, on the same walk that catches a Workers global read off the global scope. It is why a browser reading a customer's Worker does not need to be told which of the kit's own modules it may name.
