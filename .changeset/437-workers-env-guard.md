---
"@pithy-sh/cloudflare": minor
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

A workers suite cannot see a Cloudflare credential, and the guard that says so cannot be emptied.

#198 stopped unit suites authenticating against a live account, and the fix exempted every `*.workers.test.ts` project on a sound reason: workerd inherits nothing from the host, so there is no ambient token to blank. That answers **inheritance** and says nothing about **declaration**. A `cloudflareTest({ miniflare: { bindings } })` entry writes a host-computed value into workerd's `process.env` by design — five configs use it for `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()`, a key minted for the test and exactly what bindings are for — and the shape one line over is `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`. Nothing refused it. The exemption was a door.

**Two gates close it, and they are halves rather than duplicates.** `vitest.workers.setup.ts` at the repository root runs inside workerd and throws on any Cloudflare credential visible there, whatever put it in — a binding, a future pool option, a harness change nobody read. All seventeen workers projects load it. And `packages/cli/src/ci/testIsolation.test.ts` refuses a workers config that reads `process.env` at all. Neither is redundant: a declaration reading the operator's shell carries nothing on a machine with no token exported, which is every CI runner, so the runtime guard passes a real leak on exactly the machine the gate has to be trusted on. Measured — a planted `process.env.CLOUDFLARE_API_TOKEN ?? ""` ran 166 tests green with no token exported. The scan owns the declaration; the guard owns the runtime.

**The runtime guard reads the bindings, not only `process.env`, because a compatibility flag decided whether those are the same thing.** A declared binding lands in `process.env` only while the config states `compatibilityFlags: ["nodejs_compat"]`. Measured on `@pithy-sh/core`: delete that one line, declare `bindings: { CLOUDFLARE_API_TOKEN: "leaked-nocompat" }`, and the whole set goes green — the scan returns `[]`, the workerd assertions pass, and the credential is fully readable from any test through `env` from `cloudflare:test`. Blindness cannot be detected from inside either: with the flag and without it, `typeof process` is `"object"`, the key set is the same seven, and `process.version` is `"v22.19.0"`. So the guard reads the bindings themselves, where no flag can hide them, and `testIsolation.test.ts` holds every workers config to the flag — a suite exercising a workerd the deployed Worker is not is worth refusing on its own.

**The source scan follows the imports rather than the file name.** Its own docblock rejected a narrower rule as "walked around by a helper that reads the environment one call away", and a rule scoped to `vitest.workers.config.ts` had that hole: all seventeen import `../../vitest.shared`, where an `export const HOST_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ""` would be invisible and would flow straight into a `bindings` entry. The population is now every repository module a config reaches, transitively — derived by walking relative imports, so the next one is covered by the commit that adds it — and a specifier the walk cannot resolve is reported rather than skipped. The stripper it reads through is string-aware for the same reason: a `//` inside a URL and a `/*` inside a `**/*` glob each forged a comment that blanked a real `process.env` read, and both were silent.

**`visibleCredentialKeys` is the one new export**, on `@pithy-sh/cloudflare`'s `src/env/devVars`. It answers which of `CLOUDFLARE_ENV_KEYS` an environment carries a non-empty value for — non-empty, because `vitest.shared.ts` pins all four to `""` and the CLI's `process.env` overlay already reads a blank as unset. That module imports nothing at all, and now must keep importing nothing: it is bundled into workerd as well as run on the host, so a `node:` import in it breaks seventeen suites at collection.

**The guard is gated on doing something, which for one review it was not.** Every check around it proved seventeen configs cite the file and that the file exists. Replace its body with `export {};` and all of them stay green — 18 passed in the CLI gate, 169 in `@pithy-sh/core`'s workers project — with the whole mechanism retired in silence. That is this repository's named recurring defect one level up from where the change looked for it. So the guard records its scan on `globalThis` and `packages/core/src/worker/envIsolation.workers.test.ts` reads the record back from inside workerd, where the guard runs. The throw is the one clause still held by text, and deliberately: proving it at runtime means putting a live credential into a real workers pool.

**The scaffolded config is scanned too.** `templates/starter/vitest.workers.config.ts` can state neither setup file — both are absolute paths only this checkout has — so it stays out of the walk that loads configs. It does not stay out of the source scan, which names no path and forbids a text. It is the one workers config in this tree that becomes somebody else's code, so a scaffolded `bindings: { CLOUDFLARE_API_TOKEN: … }` would ship from here and reach *their* account.

**Nothing changes for an adopter's own repository.** The scaffold is unchanged, and the guard is a repository-root file that `pithy init` does not copy. What moves in these tarballs is a `setupFiles` line in seventeen `vitest.workers.config.ts` files that pack with their `src`, plus the new function — no runtime code, and nothing an import of `@pithy-sh/<capability>` reaches.
