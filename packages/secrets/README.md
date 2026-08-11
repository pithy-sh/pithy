# @pithy-sh/secrets

Encrypted secret storage for Pithy. One dedicated store per environment, a worker-only master key, automatic at-rest key rotation, and the `pithy secrets` CLI to manage it.

## Why it's shaped this way

Secrets are the one capability that does **not** ride the per-feature ephemeral lifecycle. A deployed feature worker still needs the DKIM key, webhook secrets, and the auth signing key, and a global secret must be present in every environment at once. So secrets live in their **own** `SECRETS` D1 — separate from the app `DB`, which is provisioned and torn down per feature branch — and the thing that *manages* them is a singleton per environment.

## Two backends, registry-driven

Each entry in your `SecretRegistry` declares:

- **`backend`** — `d1` (an encrypted row in this env's secrets store) or `cf-secrets-store` (a native Cloudflare Secrets Store entry bound into the worker).
- **`scope`** — `environment` (a different value per env) or `global` (the same everywhere).
- **`rotatable`** — a boolean; forward-looking metadata for a future value-rotator. It does not change storage or the read API.
- **`valueType`** — `text` or `json` (with a Zod schema).
- **`devValue`** — optional. Set it to `random` when the value is *arbitrary*, and `pithy add <capability>` mints this project's dev value into the dev secrets file (see below). Leave it off when the value must match something outside the project.

The reader routes off these axes, resolves every secret **locally** (no RPC), and exposes one uniform API: `get(name)` for the current value, `getVersions(name)` for the current pointer plus every still-valid version. `backend` is a **storage** decision, not a read-time one — moving a secret between `d1` and `cf-secrets-store` is a one-line registry edit and every read site stays byte-identical. In local dev the same names resolve from `.dev.vars`; deployed, they resolve from the env's store. The call site is identical.

You almost never call the low-level reader directly — read through the **shared per-invocation accessor** below.

## One uniform serde

Every `d1` secret is stored the same way — a `{ currentVersion, versions }` envelope sealed in one AES-256-GCM envelope (the same shape as the master-key config). A new secret is one version; a value rotation (deferred) appends the next and repoints `currentVersion`. Storing consistently is how adding a value-rotator later becomes append-a-version, not reshape.

**The secret's stored name is sealed in as authenticated data.** It is not encrypted, it is *bound*: a ciphertext lifted from one row and written into another does not open, because the name the decryptor supplies no longer matches the one sealed with it. That includes a keyspace member, whose bound name is the whole `<entry>/<key>` — one tenant's credential does not open under another tenant's key. Which secret a caller gets stops being a property of the query alone, and a bug up there becomes a clean `secrets/crypto_failed` rather than a disclosure.

The name is safe to bind because nothing renames a secret. A rename is a `put` under the new name and a `delete` of the old, which re-seals through the plaintext. `UPDATE ... SET name` in raw SQL leaves a row nothing can open — that is the property working, not a bug.

## Shared per-invocation accessor

Within one worker invocation, many capabilities each read secrets. Resolving them independently means a Secrets Store round-trip per call site, and a *repeated* round-trip when two capabilities share a secret. The shared accessor (`sharedSecretsStore`) resolves the **combined** registry — every capability's slice merged — exactly once per invocation, caches the result for a short TTL, and hands each call site a precisely-typed view over only its own slice.

### Which function do I call?

There is **one** front door for reading a secret value at runtime:

- **`sharedSecretsStore(env, registry)`** — what every capability and worker calls. Resolves the combined registry once, caches it for the TTL, and returns a typed accessor over your slice. Use this.
- **`secretsStore(env, registry)`** — the low-level reader the shared accessor is built on. It always resolves the registry you pass with no caching. You normally never call it directly; it is the primitive the shared layer (and its tests) use. There is no behavioral reason to reach past `sharedSecretsStore` in worker code.
- **The master key is the one exemption.** `SECRETS_ENCRYPTION_KEYS` — the AES key that decrypts the `d1` store — cannot be read through the store reader (it *is* the bootstrap that makes the store readable). It is read directly via `resolveEncryptionConfig(env)`, only inside the manager/store internals. No other secret is read outside the accessor.

Everything that reads a secret value — the email link-signing key, the turnstile widget secret, the manager's CF API token — goes through `sharedSecretsStore`. The master key is the sole, deliberate exception.

### Each capability declares its slice

A capability that reads secrets declares the slice it needs on the base `Capability` contract:

```ts
defineCapability({
  name: "turnstile",
  dependsOn: ["secrets"],
  secretRegistry: turnstileSecretsRegistry, // this capability's slice
  requiredBindings: [],
});
```

`secretRegistry` is additive and optional. A capability declares **only its own** secrets — never another capability's. The secrets capability's own slice is the project-wide registry you pass to `secrets({ registry })`.

### Startup aggregation

When `createBackend` assembles the worker, it fires each capability's `compose` hook with the full composed set. The secrets capability uses that hook to merge every capability's `secretRegistry` into one combined registry, then configures the shared accessor from it. A secret name declared by more than one capability is allowed only when the declarations agree on every axis (`backend`, `scope`, `valueType`, `rotatable`); a divergent re-declaration throws at startup. The combined registry of any worker is exactly the union of the slices read *in that worker* — nothing more.

### The singleton and its TTL

The cache is module-scoped, so it is per worker isolate. It is built lazily on the **first** request that needs secrets — the combined registry is resolved once (a concurrent first read shares the one in-flight resolution), and the resulting accessor is cached. Every access within the TTL reuses it with no re-fetch. The first access after the TTL expires re-fetches the full combined set. The default TTL is **60 seconds**, configurable per project:

```ts
secrets({ registry, secretsCacheTtlSeconds: 30 });
```

Lower it to pick up a rotated secret sooner; raise it to cut Secrets Store round-trips further. Caching ignores `env` because a worker's bindings are stable across requests in an isolate — the explicit `ENVIRONMENT` signal that flips dev vs deployed resolution does not change within an isolate.

### Typed views, one resolution

A call site reads through `sharedSecretsStore(env, itsOwnRegistry)`, which returns a `SecretsAccessor` typed to that registry alone — `get`/`getVersions` stay fully typed. Under the hood it resolves the combined registry once (honoring the cache) and returns `combined.subset(itsOwnRegistry)`: a view restricted to the requested names, sharing the already-resolved values, with no second fetch. Migrating a direct reader is a one-line swap from `secretsStore(env, registry)` to `sharedSecretsStore(env, registry)`. Every requested name must be part of the aggregated registry; a name no capability declared is a wiring bug and throws at the call.

### Standalone workers

The prebuilt email and secrets-manager workers are not assembled by `createBackend`, so their `compose` hook never runs. They configure the shared accessor directly from their own registry at module scope:

```ts
configureSharedSecrets({ registry: managerRegistry });
```

Each then reads through `sharedSecretsStore(env, managerRegistry)` like every other worker, so a rotation run resolves `CLOUDFLARE_API_TOKEN` through the one cached path. These workers use the **default** TTL; `secretsCacheTtlSeconds` tunes only the `createBackend`-assembled app worker. They are single-purpose and read one secret per run, so the cache lifetime barely matters there.

### Where the pieces live

The `Capability` contract and the `compose` startup hook live in `@pithy-sh/core` — it carries the `secretRegistry` slice as a structural seam but never interprets it, so `core` keeps no dependency on `@pithy-sh/secrets`. All aggregation, the singleton, the TTL, and resolution live here, in `@pithy-sh/secrets`. Resolved plaintext is held in `#private` fields and `toJSON` redacts, so caching it for the TTL never widens the leakage surface.

## Per-environment manager

`pithy add secrets` deploys one prebuilt manager worker per environment (`<project>-staging-secrets`, `<project>-prod-secrets`). The user authors no code for it. Each manager hosts:

- the **write Workflow** — the CLI's dispatch target for create/update/remove;
- the **at-rest key-rotation Workflow + cron** — generates a fresh master key, re-encrypts every row, prunes the old key once none remain, and records the rotation. Runs once per environment, never in a feature branch.

## Provisioned resources

`pithy secrets provision` creates these per environment (and `pithy secrets deprovision` removes them). The D1 database shares the worker's name. The Secrets Store itself is not created here — its id comes from `SECRETS_STORE_ID`.

`<project>` below is the `name` in your root `pithy.config.ts`, and the rule is [`docs/NAMING.md`](../../docs/NAMING.md)'s `<project>-<env>-<thing>`. It matters most here, and in two directions. An account has **one** Secrets Store, flat and unpartitionable, so the entry name is the only partition there is: without the project segment a second Pithy project's `provision` would find this one's master key already there, adopt it, and encrypt its rows under a key it does not own — and either project's teardown would orphan both. The Worker script namespace is just as flat and worse behaved, because `wrangler deploy` upserts rather than refusing: an unscoped manager would not collide with the first project's, it would silently **replace** it, repointing it at the second project's database and master key. The minted manager token is scoped for the mirror-image reason: teardown deletes every token of that name, and an unscoped one would revoke every other project's manager credential in the account.

The token is `global` — one value, written once and bound by every manager of the project — so the literal `global` fills the environment slot rather than being omitted. In-worker the master key always binds as the fixed name `SECRETS_ENCRYPTION_KEYS`; only the store entry is scoped.

| Resource | staging | prod |
|---|---|---|
| Manager Worker | `<project>-staging-secrets` | `<project>-prod-secrets` |
| D1 database | `<project>-staging-secrets` | `<project>-prod-secrets` |
| Secrets Store entry (master key) | `<project>-staging-secrets-encryption-keys` | `<project>-prod-secrets-encryption-keys` |
| Secrets Store entry (manager CF token) | `<project>-global-secrets-manager-cf-api-token` — one global entry, bound by both | ↩ |
| CF API token (the manager's runtime credential) | `<project>-global-secrets-manager` — one global token, minted once | ↩ |
| Write Workflow | `<project>-staging-secrets-write` | `<project>-prod-secrets-write` |
| Rotation Workflow | `<project>-staging-secrets-rotate` | `<project>-prod-secrets-rotate` |

Every name in that table survives whole at the longest legal project name. Cloudflare publishes no length limit for a Secrets Store entry, so Pithy's own ceiling of 128 characters applies — not the 63 these were once held to, which hashed `<project>-prod-secrets-encryption-keys` down to `secrets-encryp-91c2e9` on a long project, for nothing. The full table of limits, and which of them are ours rather than Cloudflare's, is in [`docs/NAMING.md`](../../docs/NAMING.md).

## Credentials (`.dev.vars`)

Provisioning reads **one** Cloudflare API token from `.dev.vars` (or `process.env` in CI):

| Variable | Used for | Scope it needs |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | The broad bootstrap token — authenticates the deploy and the provisioning REST calls (create D1, write the store, deploy the manager Worker), **and mints the manager's own runtime token**. | Workers Scripts, D1, Secrets Store, Workflows — plus **Account API Tokens Write**, the permission that lets it mint the manager token. |

`pithy add secrets` writes one more line there: `SECRETS_ENCRYPTION_KEYS`, this project's **dev** master key. It is the one binding value an adopter cannot invent — a JSON `EncryptionConfig`, not a string — and `wrangler.jsonc` has nowhere to hold it, so without it `pithy dev` refuses every request. It is generated per project, never a shipped literal: one key in a template is one key across every adopter. It is written **only when absent**, for the reason `ensureMasterKey` states — replacing it orphans every secret already stored — and it goes to `.dev.vars`, which is gitignored, never to the committed `.dev.vars.example`. It is local only. Deployed environments get theirs from `pithy secrets provision`.

Every other capability gets the same treatment through its registry. An entry that declares `devValue: "random"` — auth's `auth-session-secret`, email's `email-link-signing-key` — is minted into the dev secrets file by `pithy add <capability>`, under the same three rules: random per project, only when absent, and never in a committed example. These matter more than the master key does, because nothing names them: they are read lazily, so the app boots healthy, `/health` is green, and the failure arrives at the first sign-in as `secrets/not_found`. The capability that owns the secret decides — the CLI holds no list of names to drift. An entry whose value must match something outside the project (an OAuth client secret, a Stripe key) declares no `devValue` and is left to `pithy secrets create`, because a generated value there authenticates against nothing.

`pithy secrets provision` mints the manager's least-privilege runtime token itself — a scoped, account-owned CF API token with **Secrets Store Read + Write only** — and writes it straight into the Secrets Store as `<project>-global-secrets-manager-cf-api-token`. The operator never creates or sees it. The broad token never reaches the worker; the minted token never deploys. If the bootstrap token lacks **Account API Tokens Write**, the mint fails fast with an actionable error. Teardown deletes the minted token. (Also required: `CLOUDFLARE_ACCOUNT_ID` and `SECRETS_STORE_ID`.)

## The CLI

```
pithy secrets provision       # stand up each env's D1, master key, and manager (idempotent)
pithy secrets deprovision     # remove the managers + databases (--keys also deletes the master keys)
pithy secrets create <name>   # create — fails if it already exists
pithy secrets update <name>   # update — fails if it doesn't exist
pithy secrets rm <name>       # remove
pithy secrets ls [--check]    # list state; --check runs the audit (the promote gate)
```

The CLI is the **cross-environment actor**: a `global` write reaches both environments (a D1 secret fans out; a CF-Secrets-Store secret is written once, canonically, via prod); an `environment` secret takes `--env` and touches one. Because the master key is worker-only, every value-touching command **dispatches the manager's Workflow** and polls — the CLI never encrypts or stores locally. It is also the **authoritative validator**: a not-yet-deployed secret's schema is in no worker yet, so the CLI validates the value against the registry before dispatching. Values come from a prompt or secure stdin, never a flag; `--json` throughout.

## Security

- The master key lives in CF Secrets Store, bound only to that env's workers, and is read only inside a worker.
- Each env's workers bind only their own env's store and key — a staging worker can't reach prod ciphertext.
- The manager's CF API token is a Secrets Store binding (never a plaintext env var) scoped to **Secrets Store Read + Write only** — least privilege for its sole job, the rotation write-back. The broad bootstrap token never reaches the worker.
- JSON validation errors are redacted (`path:code`, never the value).

Adoption is never gated behind Bun: this package is pure ESM on Node 22+.
