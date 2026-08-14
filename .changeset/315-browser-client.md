---
"@pithy-sh/core": patch
"@pithy-sh/ledger": minor
"@pithy-sh/payments": minor
"@pithy-sh/support": minor
"@pithy-sh/testers": minor
---

Let a browser name a scope without acquiring `ExecutionContext`.

A scope name is a string an admin client is supposed to know. The whole control-plane design has a client discovering a Worker's admin routes from the manifest and naming the scope each needs — `pithy-sh/dashboard` renders what a connection may do from these constants, and writes its `pithy dashboard connect --scope …` command from them, in a Vite client with the DOM lib and no Workers types.

It could not. Four capabilities declared their scopes in the same module as their Hono middleware, so importing `PAYMENTS_ENTITLEMENT_GRANT_SCOPE` compiled `PithyHonoEnv`, which reached core's `capability.ts`, which named `ForwardableEmailMessage` and `ExecutionContext` off the global scope. Four errors, none of them in the adopter's own code, and no way to silence them short of excluding the kit from typechecking.

**`@pithy-sh/ledger`, `@pithy-sh/payments`, `@pithy-sh/support` and `@pithy-sh/testers` now declare their scopes in `src/http/scopes.ts`** — the constants, the `*_CONTROL_PLANE_SCOPES` list, and the `*AdminRoutes()` builder, which belong beside them so the scope a route demands and the scope a manifest advertises stay one constant. No name changes and no value changes; the import path does. `guards.ts` keeps the middleware and imports the names like anything else. `@pithy-sh/audit`, `@pithy-sh/auth`, `@pithy-sh/email` and `@pithy-sh/secrets` already imported nothing but types and are untouched.

**`capability.ts` imports `ForwardableEmailMessage` and `ExecutionContext` by name**, and `@pithy-sh/core` declares `@cloudflare/workers-types` as a dependency rather than a devDependency. A type this file names is a type its consumers must be able to get.

**`sha256Base64Url` and `verifyEd25519` copy before they hash and verify.** `crypto.subtle` takes a `BufferSource`, which excludes a view onto a `SharedArrayBuffer`; a bare `Uint8Array` does not. Workers types spell `BufferSource` loosely enough that the mismatch never surfaced in a Worker, so this read as a DOM-lib nuisance — it is not. A digest of memory another thread can write is a check that does not bind what it checked, and body binding is the whole reason `bodySha256` exists. The copies are a request body and sixty-four bytes.

`tooling/browser-scopes` is the gate, and it is three programs. One compiles every control-plane scope the kit declares under the DOM lib with `types: []`. One compiles the token primitives and the capability contract the same way, because the first program stopped reaching them the moment the scopes moved — a gate that passes whether or not the thing it proves is true is worth less than no gate. A test holds the fixture to every declared scope and holds each scope's home module to type-only imports, so the declaration cannot drift back in beside the middleware that reads it.
