# Scoped Cloudflare API tokens

`pithy token` mints the scoped, least-privilege, account-owned Cloudflare API tokens your project needs, so you never hand-craft a token in the dashboard. There are two kinds: the one **`ci-system`** credential your CI pipeline runs under, and **worker-consumer** tokens a deployed Worker reads via its binding (e.g. the secrets manager's runtime token).

## The bootstrap token

Everything starts from the one credential you set by hand: the bootstrap `CLOUDFLARE_API_TOKEN` (plus `CLOUDFLARE_ACCOUNT_ID`) in `.dev.vars`, or the same env vars locally. `pithy` uses it to mint every other token.

**Least privileges the bootstrap token needs.** At minimum **API Tokens → Edit** (account scope), so `pithy` can create, roll, and delete account-owned tokens.

**The delegation rule.** Cloudflare only lets a token create another token whose permissions it already holds. So the bootstrap token must itself hold **every permission it delegates into a minted token** — the union of your `ci-system` permissions (see below) plus API Tokens Edit. Names are resolved against your account at mint time; an unknown or missing one fails loudly, never silently mis-scoped.

## `ci-system` — the one CI credential

CI runs migrate and deploy in one process under one credential, so there is one CI token: `ci-system`. Its permissions are the **base** — deploy Workers, migrate remote D1, read/write the Secrets Store — **plus whatever the composed capabilities need CI to do**. You never hand-list them.

```bash
pithy token mint ci-system --env production
```

**How you use it in CI.** CI has no `.dev.vars`, and neither secret store is readable from outside a Worker — so the flow is: mint the token, read its value out, and set it as your CI system's `CLOUDFLARE_API_TOKEN` secret. This is exactly why the `dev-vars` and `ephemeral` stores exist.

- **`--store dev-vars`** (the default) writes the value to `.dev.vars.production` as `CF_TOKEN_CI_SYSTEM`. Read it, paste it into your CI provider's secret store as `CLOUDFLARE_API_TOKEN`, done. Your CI's `pithy migrate` / `pithy deploy` then run under least privilege.
- **`--store ephemeral`** writes nothing — for a single CI job that mints and uses the token in the same step.

The value is never printed to stdout or `--json`; `dev-vars` is how you get it out to configure CI.

### Extending what CI can do

`ci-system` is not a fixed list — every composed capability contributes what it needs. A capability declares it next to its code:

```ts
// a capability that provisions Email Routing in CI:
ciPermissions: ["email:routing"]
// a module that seeds KV during install:
ciPermissions: ["kv:write"]
```

`pithy token mint ci-system` mints `base ∪ (every capability's ciPermissions)`. Add a capability and the CI token grows to match — no hand-editing of scopes. Adopters override the whole set in `pithy.config.ts` (`tokens.overrides["ci-system"]`) or per mint with `--permission`.

## Worker-consumer tokens

Some tokens are read by a deployed Worker, not by CI — the secrets manager's runtime credential is the example. A capability declares one as a token profile next to its secret registry:

```ts
// the secrets capability, next to its code:
tokenProfiles: {
  secrets: {
    permissions: ["secrets:read", "secrets:write"],
    secret: "GLOBAL_SECRETS_MANAGER_CF_API_TOKEN",  // the CF Secrets Store entry the Worker binds
    defaultStore: "secrets-store"
  }
}
```

Its value is written to the **CF Secrets Store** under the named secret, and the Worker reads it via its binding.

## Where a token is written — the store

A minted value never prints. It is written to one of:

- **`secrets-store`** — the CF Secrets Store; a Worker reads it via its binding. The destination for a worker-consumer token. If a profile doesn't name a store, the destination comes from the token's **declared secret** in your secret registry (`defineSecretRegistry`) — the registry, not a flag, decides where a store-backed token lives (CLAUDE.md §secrets). A token can't live in the encrypted D1 store (Worker-only); declare it `cf-secrets-store`.
- **`dev-vars`** — the git-ignored `.dev.vars.<env>`, readable back by a later CLI run. The `ci-system` default.
- **`ephemeral`** — nothing is written; the value is used in-process.

Override any mint with `--store`. A flag wins over the profile default, which wins over the registry backend.

## Commands

Every command is non-interactive, `--json`, `--env`-targeted, and never prints a token value.

```bash
# Mint (or reuse a still-valid one) and write it to the token's store.
pithy token mint ci-system --env production

# Force a fresh value; redirect the store for this mint.
pithy token mint ci-system --env production --refresh --store ephemeral

# List minted tokens for an environment — ids and profiles, never values.
pithy token list --env production

# Rotate: mint a new token, store it, delete the old one. --keep-previous holds the old one
# as a grace window while a Worker consumer picks up the new value (redeploy first).
pithy token rotate secrets --env production --keep-previous

# Revoke: delete the profile's token for an environment.
pithy token revoke ci-system --env production
```

Minting rolls in place: the token name is a stable `(profile, env)` identity, and each mint regenerates its value with the profile's **current** permissions — so adding a capability's `ciPermissions` takes effect on the next mint, and re-minting never orphans a token. Every mint, rotate, and revoke emits an audit event (`cloudflare/token_minted`, `…_rotated`, `…_revoked`) through the core audit seam **when the project composes `@pithy-sh/audit`**; it is a no-op when it does not (audit stays optional — the CLI never hard-depends on it).

## Environments

Tokens are per-environment. A staging token is stored under and used only for staging; it never reaches production. Mint one per environment you deploy.
