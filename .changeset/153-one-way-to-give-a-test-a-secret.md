---
"@pithy-sh/secrets": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/payments": patch
"@pithy-sh/email": patch
"@pithy-sh/auth": patch
---

One way to give a test a secret, in `@pithy-sh/secrets/src/test-utils/secretFixtures`.

Until #153 there was nothing to share, because nothing was needed. Dev resolved every secret from a plaintext binding whatever its registry said, so a test put `{"auth-session-secret": "x"}` on the worker env and the reader took it. Four capability packages learned that trick independently, and 139 tests used it. It was never a fixture: it was a product code path, bent — and #153 removed it. Anyone writing a capability against this kit hit the same wall on the same day.

**`seedSecrets(env, registry, values)` is the Workers-runtime answer.** It writes the real encrypted row: the same value envelope, the same AES-256-GCM envelope, the same master-key resolution, the same schema validation at the read. The code under test reads through `secretsStore` exactly as a deployed worker does, which is the point of running in workerd at all. It creates the secrets tables on first use, so a suite needs no migration step of its own, and it upserts, so a case that wants different credentials than its suite's default just seeds over them.

**`stubSecrets(registry, values)` is the Node-runtime answer,** and the split is decided by the runtime rather than by taste. There is no D1 in a Node project and `SystemSecretsStore` needs one, so the resolved accessor is built in memory and installed at `configureSharedSecrets`'s `resolve` seam — a seam that exists to be replaced. A name the fixture omits stays *unresolved* rather than becoming `undefined`, so "declared but never provisioned" is expressible and reads as `secrets/not_found`.

Both take the capability's own registry, and both hold a value to it: a `json` fixture is checked against the entry's schema before it is stored or resolved, so a fixture production would reject fails at the line that wrote it, naming the secret and never echoing the value.

`devEncryptionKeys()` mints the `SECRETS_ENCRYPTION_KEYS` binding a seeding suite needs. It is a module of its own with no runtime imports, because a `vitest.workers.config.ts` is loaded through Node's own resolver and cannot follow this repository's extensionless specifiers — import anything heavier and the config stops loading before a single test runs.

**What a package adopting this has to add.** `d1Databases: ["SECRETS"]` and a `SECRETS_ENCRYPTION_KEYS` binding on its Miniflare config, and the two entries on its `Cloudflare.Env` declaration. That is the same cost #153 states for a deployed Worker, arriving in the test suite for the same reason: a `d1` secret has one home now, and tests read it from there.

`turnstile`'s middleware doc no longer says the widget secret resolves from `.dev.vars` in local dev. It resolves from the row, everywhere.

Nothing about any capability's behavior changes here. Everything about how its tests say "this secret has this value" does.
