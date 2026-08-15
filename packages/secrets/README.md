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
- **`rotateEveryDays`** — optional; how often this secret is expected to be rotated. It is what makes "overdue" a fact the capability states rather than a number a dashboard invented. Independent of `rotatable`: a third-party key no automation will ever rotate is exactly the one whose drift nothing else surfaces.
- **`keyed`** — optional; declares a *keyspace* rather than a name. One schema, an unbounded set of members whose keys exist only at runtime. See [Keyspaces](#keyspaces--one-credential-per-tenant).

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

## Keyspaces — one credential per tenant

A named entry is one secret with one value. A `keyed: true` entry declares a **keyspace**: one schema, one backend, and an unbounded set of members whose keys only exist at runtime — one signing key per customer connection, one API key per tenant, one webhook secret per workspace. The registry can no more list those names than it can list next month's customers.

A member is stored as `<entry>/<key>` in the same encrypted table as everything else, so at-rest rotation, the audit and teardown keep working with no second storage path. `/` is the one separator and a registry entry may not contain it, so a member can never collide with a declared secret. Every key is validated before it is composed (`SecretKey`), so `../OTHER/victim` is refused at the call rather than resolved at the store.

```ts
const secrets = await sharedSecretsStore(c.env, registry);

// Mint a credential and store it — inline, on the request.
await secrets.putKeyed("CONNECTION_SIGNING_KEY", connectionId, { privateJwk }, {
  audit: { emit: c.var.emit, actorType: "user", actorId: user.id },
});
return c.json({ publicJwk });                                   // the private half is already stored

await secrets.rotateKeyed("CONNECTION_SIGNING_KEY", connectionId, { privateJwk: next });  // both valid
await secrets.getKeyedVersions("CONNECTION_SIGNING_KEY", connectionId);   // verify against either
await secrets.deleteKeyed("CONNECTION_SIGNING_KEY", connectionId);        // the tenant leaves
```

**The write is synchronous, in-Worker, on the request path — and it has to be.** Sealing can only happen in a Worker, because the master key is a binding and the CLI does not have it. For a secret an operator provisions, the CLI dispatching the manager Workflow is right: nobody is waiting on the response. For a credential minted *during* a request it is not, and the reason is ordering rather than latency. A connect flow must return the public half in the same response that sealed the private one; returning a public key whose private half is not yet stored hands out a credential that cannot be used, and discovers it later, at the customer. So `putKeyed` resolving **is** the persistence guarantee. The Workflow path is unchanged for named secrets — this adds a form, it does not replace one.

**`putKeyed` creates; it does not overwrite.** An existing member is refused with `secrets/already_exists`. Create-or-replace would make "silently overwrite this tenant's live signing key" a typo away, and the loss is total and quiet: every token already signed with the old key stops verifying and nothing says why. Adding a key while the old one still works is `rotateKeyed`, which appends a version and keeps the prior ones valid — the two-keys-during-rotation window `getKeyedVersions` exists to serve, and the reason a keyspace must be declared `rotatable` to accept one. `putKeyed(..., { replace: true })` is the explicit form for the case where the stored value must *not* survive, a leaked credential being the whole of it.

**`deleteKeyed` removes every version, and the member's rotation history, in one call.** A member is one row holding one envelope, so there is no loop for a caller to write and no version that can outlive the tenant it belonged to. It is idempotent, and it never reports whether anything was there — an error that distinguished the two would answer "does this tenant have a credential" to anyone who could call it.

**At-rest key rotation covers members.** They are ordinary rows in `pithy_secrets_system_secrets`, and the rotation cron re-encrypts rows by key version and nothing else. A separate storage path would have been a set of rows the cron never visits — the ones that quietly cannot be opened once the old key is pruned. Tested against a real store, not assumed.

**A write is an administrative act, so it is audited** — as `secrets/member_written`, `secrets/member_rotated`, `secrets/member_removed`, with the member key as the event's `tenant` and nothing about the value anywhere. The capability owns the action codes so an adopter does not invent one for the kit's most sensitive write; the recorder and the actor come from the call site, because an accessor cached across requests has neither, and an event that cannot say who wrote a credential is missing the one thing worth recording. Pass `audit` and it is recorded; omit it and nothing is.

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

## Control-plane surface

Two reads and one write, each behind its own scope, so an adopter grants secret status separately from everything else at `pithy dashboard connect` — and grants replacing a credential separately again:

```
GET  {base}/admin/status                  # every declared secret's status         secrets:status:read
GET  {base}/admin/status/:name/rotations  # one secret's rotation history          secrets:status:read
POST {base}/admin/status/:name/rotate     # replace one secret, in this env        secrets:rotate
```

Per secret: its name, `backend`, `valueType` and `rotatable` from the registry, **how it rotates** (`rotation`), the `keyVersion` its stored envelope sits under, when it was created and last written, `lastRotatedAt`, how many rotations are recorded, the declared `rotateEveryDays`, and whether it is `overdue`. Per rotation: the timestamps, the status, the trigger, and who.

**No route reads a value, and no scope could grant one.** The response shapes are *incapable* of carrying a ciphertext, an IV, a metadata snapshot or a rotation's error message — those fields are absent from the type, not omitted by a projection, so widening them is a compile error rather than a review miss (`src/admin/status.ts`). A failure is reported as a status, never as a message: an error message is free text written at a failure site, which is where a value gets pasted by accident.

**`lastRotatedAt` moves because a rotation was recorded, not because a value was written.** `rotateSecretValue` opens a row in that environment's `pithy_secrets_rotations` before it rolls and closes it with what happened, and it takes the ledger as a required argument — so the in-Worker path and `pithy secrets rotate`, which reaches the same table over a dispatch to the manager Workflow, leave the same rows. An ordinary write does not record one: a first store is `trigger: baseline`, a rotation is `manual` or `cron`, and `pithy secrets update` is neither.

Three nulls, three different facts. `lastRotatedAt: null` is **never rotated** — not zero, and not rotated long ago. `createdAt: null` means nothing is stored under that name in this database, which is why `backend` is reported: a `cf-secrets-store` secret never has a row here. `overdue: null` means the question has no answer, either because no cadence is declared or because there is nothing to measure from.

The listing covers every **composed capability's** secrets — auth's signing key, email's link key — not only the ones you typed. Keyed entries are excluded: a keyspace has no single value, and its members are per-tenant rows, so listing them would be a tenant enumeration.

### `rotation` — how a secret is replaced

`rotation` carries the registry entry's own declaration: `local` (the kit mints another from the same recipe), `provider` (its issuer is called and returns the successor), or `manual` (a human, in a console, with the issuer and the page named). `null` means the entry declares nothing, which is **not** the same as `manual`.

It is not `rotatable`, and the two disagree in this repository: `SECRETS_ENCRYPTION_KEYS` is `rotation: local` and `rotatable: false`, while a payments credential is `rotatable: true` and rotates only by hand. `rotatable` says whether the stored envelope may accumulate versions; `rotation` says who does the replacing. A client that has only the first has to guess, and the only safe guess is to offer nothing.

Nothing in it can hold a value: a kind from a closed set, an issuer from a closed set, and a documentation URL the schema holds to `https:`.

### Rotating one secret

`POST {base}/admin/status/:name/rotate` replaces one secret in **this Worker's own environment** and answers what happened, per environment:

```json
{ "rotation": { "name": "session-key", "status": "rotated", "kind": "local",
                "rolled": false, "rollFailed": false,
                "recorded": ["prod"], "stranded": [], "reason": null, "attempts": null } }
```

`status` is `rotated`, `unchanged`, `unrecorded` or `failed`. **`unrecorded` is the one that needs a human now**: the issuer rolled the credential and the store did not take its successor, so the previous value is dead where it was issued and no retry repairs it. It answers 200 like the others, deliberately — a 500 renders one sentence and drops `recorded` and `stranded`, which is the "all rotated" summary over a partial failure the design exists to refuse. Rotations are audited as `secrets/rotated`, `critical` on that member, carrying the operator, the secret, the environments and the flags — never a value.

**A rotation supplies nothing, which is why this write can exist where create and update cannot.** A management client holds neither your registry nor your Zod schemas, so it could not write a value against the schema that governs it. A rotation's successor is produced *inside* the Worker, from the entry's own recipe or its own rotator, so nothing crosses in either direction.

**What a Worker refuses, before anything is rolled.** A Worker holds one environment's D1 and its own master key, and that is the whole of what it can replace. A `cf-secrets-store` secret (one account-level entry, written through Cloudflare's API with a token an app Worker must never hold) and a `global` secret (identical in every environment by definition) are answered `secrets/rotation_unsupported` (409) naming `pithy secrets rotate`, which holds the whole project and can do both. So are a keyspace, an undeclared rotation, a `provider` secret with no rotator, the master key, and a name this environment has never stored — that last one because discovering it *after* a provider roll would manufacture the unrecorded incident out of a configuration gap that cost nothing to check.

`secrets:rotate` never enters a default grant. `pithy dashboard connect` derives its default from route methods, and every route requiring this scope is a `POST`.

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
- The control-plane status surface is read-only and metadata-only, by construction. It is audited on every call: a credential that quietly enumerates a project's secret estate otherwise leaves no trace, because nothing changed.

Adoption is never gated behind Bun: this package is pure ESM on Node 22+.
