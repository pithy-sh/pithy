# Scoped Cloudflare API tokens

_The reader's version of this page is [pithy.sh/docs/core-concepts/cloudflare-tokens](https://pithy.sh/docs/core-concepts/cloudflare-tokens). This copy stays in the kit because `packages/cli/src/doctor/cloudflare.ts` sends an adopter to it by name._

`pithy token` mints the scoped, least-privilege, account-owned Cloudflare API tokens your project needs, so you never hand-craft a token in the dashboard. There are two kinds: the one **`ci-system`** credential your CI pipeline runs under, and **worker-consumer** tokens a deployed Worker reads via its binding (e.g. the secrets manager's runtime token).

## The bootstrap token

Everything starts from the one credential you set by hand: the bootstrap `CLOUDFLARE_API_TOKEN` (plus `CLOUDFLARE_ACCOUNT_ID`) in `<config>/cloudflare.json` — account-scoped, outside every checkout, written by `pithy init` — or the same env vars, which overlay it per key and are how CI supplies them. `pithy` uses it to mint every other token.

**Least privileges the bootstrap token needs.** At minimum **API Tokens → Edit** (account scope), so `pithy` can create, roll, and delete account-owned tokens.

**The delegation rule.** Cloudflare only lets a token create another token whose permissions it already holds. So the bootstrap token must itself hold **every permission it delegates into a minted token** — the union of your `ci-system` permissions (see below) plus API Tokens Edit. Names are resolved against your account at mint time; an unknown or missing one fails loudly, never silently mis-scoped.

## Token names are project-scoped

A minted token is named `<project>-<env>-<profile>` — `acme-production-ci-system`, `acme-staging-secrets`. Cloudflare's token list is account-wide and flat, so the project segment is what keeps two Pithy projects in one account from listing, rotating, and revoking each other's credentials. `pithy token list` filters on the `<project>-<env>-` prefix and shows nothing outside it.

The store entry a token's value is written to is scoped the same way. The **variable name is not** — `CF_TOKEN_CI_SYSTEM` stays as it is, because it is a variable key your pipeline reads, not a name in a shared namespace.

`<project>` is `name` in the root `pithy.config.ts`. See [`NAMING.md`](NAMING.md) for the rule and its length budget.

## `ci-system` — the one CI credential

CI runs migrate and deploy in one process under one credential, so there is one CI token: `ci-system`. Its permissions are the **base** — deploy Workers, migrate remote D1, read/write the Secrets Store — **plus whatever the composed capabilities need CI to do**. You never hand-list them.

```bash
pithy token mint ci-system --env prod
```

**How you use it in CI.** CI has no Pithy config directory, and neither secret store is readable from outside a Worker — so the flow is: mint the token, read its value out, and set it as your CI system's `CLOUDFLARE_API_TOKEN` secret. This is exactly why the `dev-vars` and `ephemeral` stores exist.

- **`--store dev-vars`** (the default) writes the value to `<config>/<project>/tokens.json`, under that environment, as `CF_TOKEN_CI_SYSTEM`. **Nothing is written into the checkout, for any environment** — it used to be `.dev.vars.<env>`, which put a live production credential in a directory `npm pack` can reach. Your CI's `pithy migrate` / `pithy deploy` then run under least privilege.

  The mint prints the path. What is waiting for you there:

  ```jsonc
  // ~/.config/pithy/acme/tokens.json — mode 0600
  {
    "production": { "CF_TOKEN_CI_SYSTEM": "<the value>" },
    "staging":    { "CF_TOKEN_CI_SYSTEM": "<the value>" }
  }
  ```

  Open it, copy the value for the environment you minted, and set it as `CLOUDFLARE_API_TOKEN` in your CI provider's secrets. That copy is the whole point of this store: **you are the reader.** No Pithy command consumes this file — it is a handoff to a person, because CI cannot read either secret store and a credential has to cross that gap somehow.
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

### Your declared domains, and the route CI attaches

A Worker that declares `domains` answers on a custom domain, and deploying one is **two calls** — addressed to two different scopes, and needing the same one grant:

| Call | Endpoint scope | Grant |
|---|---|---|
| `GET`/`POST /zones/<zone>/workers/routes` — wrangler reconciles the zone's route list | zone | **Workers Routes Write**, on that zone |
| `PUT /accounts/<id>/workers/domains` — the custom domain itself | account | **Workers Routes Write**, on that zone |

**The endpoint's scope and the grant's scope are different things, and only the second one matters here.** Cloudflare's [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) is explicit: *"To add, update, or remove Routes or Custom Domains, you need `Editor` access to the Worker and `Workers Routes Write` permission for every affected zone"*, and *"API tokens need Zone > Workers Routes > Write, scoped to each affected zone."* The custom-domain call is addressed to an account path and still needs the zone grant.

So one zone-scoped grant unblocks both calls. A minted token's resources are account-scoped, and the account policy every other permission rides on grants a zone-level group nothing at all — which is why every deploy of a declared domain failed.

So `ci-system` carries a second policy: Workers Routes Write, on exactly the zones your declared domains sit in. Not account-wide, not every zone on the account, and not a group that can alter a zone — Pithy attaches routes and never touches the zone itself.

You declare nothing extra. The zones come from `domains` in each Worker's `pithy.config.ts`, composed for the environment you are minting for, and resolved by name against your account at mint time. Two consequences worth knowing:

- **A zone that cannot be scoped fails the mint**, naming what is wrong with it. Three ways: your account does not hold it, your account holds *two* of that name, or Cloudflare is not serving it yet (`pending`, `initializing`, `moved`). That is deliberate: a token minted over any of them passes every check here and fails in CI, hours later, with an error that names a zone id and nothing else.
- **The bootstrap token needs this grant too**, by the delegation rule above: Workers Routes → Edit on those zones, alongside its account permissions. Cloudflare only lets a token create a token whose permissions it already holds, so without it the mint answers 403 — and the refusal says so by name.

A project that declares no domain mints exactly what it minted before. No new permission for a project that needs none.

**An explicit `--permission` (or a `tokens.overrides["ci-system"].permissions` in `pithy.config.ts`) means exactly what it says.** The route policy rides with the profile's *default* permission set, not with every mint — so a run that narrows the credential by hand gets the narrow credential, with no zone grant added behind your back.

Two consequences follow from the mint replacing an existing token's policies:

- **`--permission` on a token that already exists is refused.** The flag would not narrow that one run; it would permanently re-scope the credential CI deploys with. The refusal names the three ways to say what you meant: drop the flag, pin the narrowing in `tokens.overrides` if it is meant to stand, or `pithy token rotate` to replace the token deliberately. A profile with no token yet mints narrowed without complaint — there is nothing to strip.
- **A standing `tokens.overrides[...].permissions` keeps stripping the grant**, on purpose. `pithy token list` reports that state as its own thing and tells you to change the override, never to re-mint — re-minting would honor the override and produce the same token again.

**A CI token minted before this** carries no zone, and the next deploy of a custom domain fails on the route. `pithy token list --env <env>` says so and names the remedy. It reads the token's own policies for the route grant **and** the zone, so a zone-scoped permission that is not a route grant does not count as coverage; when the zones or the group cannot be read it says nothing rather than guessing, and never takes the listing down with it.

The remedy is one re-mint. **It re-scopes the token in place** — `pithy` replaces the existing token's policies (`PUT /accounts/<id>/tokens/<id>`) and then rolls its value, so the credential keeps its identity, comes back with the current scope, and hands you a fresh secret to paste into CI. Scope first, value second: a re-scope that fails costs nothing, where a value handed over before the scope lands is a credential that looks new and cannot deploy.

**Anything else you set on that token is kept.** Cloudflare's token update is a full representation, so a body carrying only the policies would clear a hand-set expiry, start time or IP allowlist and re-enable a token you had disabled. Those come off the record `pithy` already read and go back with the write.

```bash
pithy token mint ci-system --env prod
```

## Worker-consumer tokens

Some tokens are read by a deployed Worker, not by CI — the secrets manager's runtime credential is the example. A capability declares one as a token profile next to its secret registry:

```ts
// the secrets capability, next to its code:
tokenProfiles: {
  secrets: {
    permissions: ["secrets:read", "secrets:write"],
    secret: "SECRETS_MANAGER_CF_API_TOKEN",  // the registry key — also the Worker's binding name
    secretScope: "global",                   // one credential for the whole project, not one per env
    defaultStore: "secrets-store"
  }
}
```

Its value is written to the **CF Secrets Store**, and the Worker reads it via its binding.

`secret` is the registry key, unscoped and unchanged. The **store entry** it lands in is `<project>-<env>-<secret>`, or `<project>-global-<secret>` when `secretScope` is `global` — so this profile writes to `acme-global-secrets-manager-cf-api-token`. `secretScope` is load-bearing rather than documentation: it is what makes `pithy token mint secrets` land on the exact entry provisioning wired the Worker to read.

## Where a token is written — the store

A minted value never prints. It is written to one of:

- **`secrets-store`** — the CF Secrets Store; a Worker reads it via its binding. The destination for a worker-consumer token. If a profile doesn't name a store, the destination comes from the token's **declared secret** in your secret registry (`defineSecretRegistry`) — the registry, not a flag, decides where a store-backed token lives (CLAUDE.md §secrets). A token can't live in the encrypted D1 store (Worker-only); declare it `cf-secrets-store`.
- **`dev-vars`** — `<config>/<project>/tokens.json`, keyed by environment, mode `0600` and outside every checkout. **A handoff to you, not to a later command.** Nothing in the CLI resolves a credential from this file: you open it, copy the value, and paste it into CI. It is the `ci-system` default for exactly that reason, and a worker-consumer token does not belong here — that one goes to `secrets-store`, where the Worker reads it through its binding without a human in the loop. The flag name is kept because it is public.
- **`ephemeral`** — nothing is written; the value is used in-process.

Override any mint with `--store`. A flag wins over the profile default, which wins over the registry backend.

## Commands

Every command is non-interactive, `--json`, `--env`-targeted, and never prints a token value.

```bash
# Mint (or reuse a still-valid one) and write it to the token's store.
pithy token mint ci-system --env prod

# Redirect the store for this mint. Every mint regenerates the value, so there is no --refresh.
pithy token mint ci-system --env prod --store ephemeral

# List minted tokens for an environment — ids and profiles, never values.
pithy token list --env prod

# Rotate: mint a new token, store it, delete the old one. --keep-previous holds the old one
# as a grace window while a Worker consumer picks up the new value (redeploy first).
pithy token rotate secrets --env prod --keep-previous

# Revoke: delete the profile's token for an environment.
pithy token revoke ci-system --env prod
```

Minting rolls in place: the token name is a stable `(profile, env)` identity, and each mint regenerates its value with the profile's **current** permissions — so adding a capability's `ciPermissions` takes effect on the next mint, and re-minting never orphans a token. Every mint, rotate, and revoke emits an audit event (`cloudflare/token_minted`, `…_rotated`, `…_revoked`) through the core audit seam **when the project composes `@pithy-sh/audit`**; it is a no-op when it does not (audit stays optional — the CLI never hard-depends on it).

## Environments

Tokens are per-environment. A staging token is stored under and used only for staging; it never reaches production. Mint one per environment you deploy.
