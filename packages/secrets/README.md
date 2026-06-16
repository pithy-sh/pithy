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

The `secretsStore` read seam routes off these, resolves every secret **locally** (no RPC), and exposes one uniform API: `get(name)` for the current value, `getVersions(name)` for the current pointer plus every still-valid version. In local dev the same names resolve from `.dev.vars`; deployed, they resolve from the env's store. The call site is identical.

## One uniform serde

Every `d1` secret is stored the same way — a `{ currentVersion, versions }` envelope sealed in one AES-256-GCM envelope (the same shape as the master-key config). A new secret is one version; a value rotation (deferred) appends the next and repoints `currentVersion`. Storing consistently is how adding a value-rotator later becomes append-a-version, not reshape.

## Per-environment manager

`pithy add secrets` deploys one prebuilt manager worker per environment (`pithy-secrets-staging`, `pithy-secrets-production`). The user authors no code for it. Each manager hosts:

- the **write Workflow** — the CLI's dispatch target for create/update/remove;
- the **at-rest key-rotation Workflow + cron** — generates a fresh master key, re-encrypts every row, prunes the old key once none remain, and records the rotation. Runs once per environment, never in a feature branch.

## Provisioned resources

`pithy secrets provision` creates these per environment (and `pithy secrets deprovision` removes them). The D1 database shares the worker's name; the master-key entries are env-prefixed because both environments share one Secrets Store, though in-worker the key always binds as the fixed name `SECRETS_ENCRYPTION_KEYS`. The Secrets Store itself is not created here — its id comes from `SECRETS_STORE_ID`.

| Resource | staging | production |
|---|---|---|
| Manager Worker | `pithy-secrets-staging` | `pithy-secrets-production` |
| D1 database | `pithy-secrets-staging` | `pithy-secrets-production` |
| Secrets Store entry (master key) | `STAGING_SECRETS_ENCRYPTION_KEYS` | `PRODUCTION_SECRETS_ENCRYPTION_KEYS` |
| Secrets Store entry (manager CF token) | `GLOBAL_SECRETS_MANAGER_CF_API_TOKEN` — one global entry, bound by both | ↩ |
| Write Workflow | `pithy-secrets-write-staging` | `pithy-secrets-write-production` |
| Rotation Workflow | `pithy-secrets-rotate-staging` | `pithy-secrets-rotate-production` |

## Credentials (`.dev.vars`)

Provisioning reads two **distinct** Cloudflare API tokens from `.dev.vars` (or `process.env` in CI):

| Variable | Used for | Scope it needs |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | The broad bootstrap token — authenticates the deploy and the provisioning REST calls (create D1, write the store, deploy the manager Worker). | Workers Scripts, D1, Secrets Store, Workflows — the usual provisioning surface. |
| `SECRETS_MANAGER_CLOUDFLARE_API_TOKEN` | The least-privilege token **written into the Secrets Store** as the manager's runtime credential. The manager's only live-CF use is the rotation config write-back. | **Secrets Store Read + Write only.** Nothing else — the rotation's D1 work runs through the `SECRETS` binding, not this token. |

The broad token never reaches the worker; the narrow token never deploys. (Also required: `CLOUDFLARE_ACCOUNT_ID` and `SECRETS_STORE_ID`.)

Until `pithy` mints the manager token itself, the operator creates `SECRETS_MANAGER_CLOUDFLARE_API_TOKEN` once (a CF API token with Secrets Store Read + Write). When minting lands, the token is generated and written straight into the store — the operator never sees it, and this `.dev.vars` entry goes away.

## The CLI

```
pithy secrets provision       # stand up each env's D1, master key, and manager (idempotent)
pithy secrets deprovision     # remove the managers + databases (--keys also deletes the master keys)
pithy secrets create <name>   # create — fails if it already exists
pithy secrets update <name>   # update — fails if it doesn't exist
pithy secrets rm <name>       # remove
pithy secrets ls [--check]    # list state; --check runs the audit (the promote gate)
```

The CLI is the **cross-environment actor**: a `global` write reaches both environments (a D1 secret fans out; a CF-Secrets-Store secret is written once, canonically, via production); an `environment` secret takes `--env` and touches one. Because the master key is worker-only, every value-touching command **dispatches the manager's Workflow** and polls — the CLI never encrypts or stores locally. It is also the **authoritative validator**: a not-yet-deployed secret's schema is in no worker yet, so the CLI validates the value against the registry before dispatching. Values come from a prompt or secure stdin, never a flag; `--json` throughout.

## Security

- The master key lives in CF Secrets Store, bound only to that env's workers, and is read only inside a worker.
- Each env's workers bind only their own env's store and key — a staging worker can't reach production ciphertext.
- The manager's CF API token is a Secrets Store binding (never a plaintext env var) scoped to **Secrets Store Read + Write only** — least privilege for its sole job, the rotation write-back. The broad bootstrap token never reaches the worker.
- JSON validation errors are redacted (`path:code`, never the value).

Adoption is never gated behind Bun: this package is pure ESM on Node 22+.
