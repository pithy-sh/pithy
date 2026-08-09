# pithy token

Mint, list, rotate, and revoke the scoped, least-privilege, account-owned Cloudflare API tokens a project needs.

## Synopsis

```bash
pithy token mint <profile> [--env <env>] [--store <store>] [--permission <key>]… [--json]
pithy token list [--env <env>] [--json]
pithy token rotate <profile> [--env <env>] [--store <store>] [--permission <key>]… [--keep-previous] [--json]
pithy token revoke <profile> [--env <env>] [--json]
```

The model behind these four commands — the bootstrap token, the delegation rule, what `ci-system` is, what a worker-consumer profile is, and where each store puts a value — is [`TOKENS.md`](../TOKENS.md). This page is the command surface.

## Flags

| Subcommand | Flag | Meaning |
|---|---|---|
| `mint`, `rotate`, `revoke` | `<profile>` (positional, required) | The token profile: `ci-system`, or a capability's worker-consumer profile. |
| all | `--env <env>` | Target environment: `dev`, `staging`, `prod`. Default `dev`. |
| `mint`, `rotate` | `--store <store>` | Override where the value is written: `secrets-store`, `dev-vars`, `ephemeral`. |
| `mint`, `rotate` | `--permission <key>` | Override the permission set. **Repeatable** — every occurrence is collected. |
| `rotate` | `--keep-previous` | Keep the old token as a grace window instead of deleting it. Default `false`. |
| all | `--json` | Machine-readable output. Default `false`. |

The permission keys `--permission` accepts are fixed and named in the flag's own help. An unknown key is refused before anything is minted, so a typo cannot produce a mis-scoped credential.

A `--store` on the command line wins over the profile's `defaultStore`, which wins over the declared backend of the profile's secret in the registry.

## What it does

**No subcommand ever prints a token value.** Not on stdout, not in `--json`, not in an audit event, not in an error. That is a property to rely on: the value goes to the store the profile resolves, and the output says only which store and where. `dev-vars` is how a value gets out to a person — `<config>/<project>/tokens.json`, mode `0600`, keyed by environment. **Nothing in the CLI reads that file.** It is a handoff: you open it, copy the value, and paste it into your CI provider's secrets. `secrets-store` writes to the CF Secrets Store for a Worker to read through its binding, with no human in the loop. `ephemeral` writes nothing at all.

`mint` **rolls in place.** The token name is a stable `(project, env, profile)` identity — `<project>-<env>-<profile>` — and each mint regenerates the value with the profile's *current* permissions. So composing a capability that contributes `ciPermissions` takes effect on the next mint, and re-minting never orphans a token. It does not reuse a stored value; that would pin the token to its old scope.

`list` reports **this project's** tokens for one environment, identities only. Two gates decide what appears: the `<project>-<env>-` prefix, because Cloudflare's account token list is flat and account-wide and includes other projects' credentials and your own; and a reverse lookup from the known profile names, because the naming facade may truncate a long trailing segment, so slicing the prefix off would hand back a string `rotate` and `revoke` cannot resolve. A prefixed token no profile claims is therefore not listed.

`rotate` is the proven two-step Cloudflare has no single call for: mint a new token under the same name and policies, store the value, then delete the tokens that predate it. `--keep-previous` leaves the old one standing as a grace window while a Worker consumer picks up the new value — redeploy first.

`revoke` deletes **every** account token of the profile's computed name for that environment. The project scope in that name is what keeps the sweep inside this project.

Every mint, rotate, and revoke emits an audit event (`cloudflare/token_minted`, `…_rotated`, `…_revoked`) carrying the token's id and its store, never its value — and only when the project composes `@pithy-sh/audit`. It is a no-op otherwise; the CLI never hard-depends on audit, and an audit write never breaks the token action it records.

Credentials come from `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` when the root `pithy.config.ts` names an account. They are account-scoped, not per project, and the account is resolved from the project's own config *before* the credentials are read — minting into a file the project did not select would create a real token in someone else's account. `PITHY_OFFLINE` refuses ambient credentials, so an offline run fails with "Cloudflare credentials are missing" rather than reaching an account nobody in the session named.

## `--json`

One line on stdout. A failure is one `{"error": …}` line on stderr and a non-zero exit.

### `token mint` · `token rotate`

| key | type | meaning |
|---|---|---|
| `command` | string | `"token mint"` or `"token rotate"`. |
| `profile` | string | The profile that was minted. |
| `env` | string | The environment it was minted for. |
| `tokenId` | string | Cloudflare's id for the token. An identifier, not a credential. |
| `store` | string | Where the value went: `"secrets-store"`, `"dev-vars"`, or `"ephemeral"`. |
| `location` | string | A human location for that store: the `tokens.json` path for `dev-vars`, `"CF Secrets Store"`, or `"(ephemeral — not written)"`. |

The token's value and its composed Cloudflare name are both on the internal result and both deliberately absent here.

### `token list`

| key | type | meaning |
|---|---|---|
| `command` | string | `"token list"`. |
| `env` | string | The environment listed. |
| `tokens` | object[] | This project's tokens for that environment. Empty when there are none. |
| `tokens[].profile` | string | The profile, recovered by exact-name lookup. |
| `tokens[].env` | string | The environment — the same one, on every row. |
| `tokens[].name` | string | The composed Cloudflare token name, `<project>-<env>-<profile>`. |
| `tokens[].tokenId` | string | Cloudflare's id for the token. |
| `tokens[].status` | string, optional | The token's lifecycle status as Cloudflare reports it: `"active"`, `"disabled"`, or `"expired"`. Absent when the account API returned none. |

### `token revoke`

| key | type | meaning |
|---|---|---|
| `command` | string | `"token revoke"`. |
| `profile` | string | The profile that was revoked. |
| `env` | string | The environment it was revoked for. |
| `name` | string | The composed Cloudflare token name the sweep matched. |
| `revokedCount` | number | How many account tokens of that name were deleted. `0` is an ordinary answer. |

## Errors

- **`Cloudflare credentials are missing.`** Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` — the bootstrap token — or record them with `pithy init`.
- **`Unknown token permission key: <key>.`** The refusal lists every legal key.
- **`Unknown token store: <value>.`** Legal values are `secrets-store`, `dev-vars`, `ephemeral`.
- **`Unknown token profile: <name>.`** The refusal lists the profiles this project actually resolves — the aggregate of its composed capabilities' declarations and its config overrides.
- **No storage is declared for the token.** The profile names no store and its secret is not in the registry. Declare the secret as `cf-secrets-store`, or mint with `--store dev-vars`.
- **The secret is declared `d1`.** A token whose value is read outside the Worker cannot live in the encrypted D1 store. Same two fixes.
- **`No CF Secrets Store is configured for the secrets-store store.`** Run `pithy add secrets` to record `SECRETS_STORE_ID`, or mint with `--store dev-vars`.
- **No project name.** The root `pithy.config.ts` needs `name`. Every token name and Secrets Store entry starts with it, and `revoke` deletes every account token of the name it computes — a guess would point that sweep at another project's credentials.
- **`--env` is validated at the flag.** `production` is answered with `prod`; anything over seven characters or outside the charset is refused before a single Cloudflare call.

## Examples

```bash
# Mint the one CI credential for production, into the dev-vars handoff file.
pithy token mint ci-system --env prod --json

# Mint the same profile with an explicit permission set, using the value in-process only.
pithy token mint ci-system --env prod --store ephemeral --permission workers:write --permission d1:write

# List this project's tokens for an environment. Ids and profiles, never values.
pithy token list --env prod --json

# Rotate a worker-consumer token, holding the old one as a grace window. Redeploy, then revoke.
pithy token rotate secrets --env prod --keep-previous --json

# Revoke.
pithy token revoke ci-system --env staging --json
```

```json
{"command":"token mint","profile":"ci-system","env":"prod","tokenId":"<token-id>","store":"dev-vars","location":"/home/you/.config/pithy/acme/tokens.json"}
{"command":"token list","env":"prod","tokens":[{"profile":"ci-system","env":"prod","name":"acme-prod-ci-system","tokenId":"<token-id>","status":"active"}]}
{"command":"token rotate","profile":"secrets","env":"prod","tokenId":"<token-id>","store":"secrets-store","location":"CF Secrets Store"}
{"command":"token revoke","profile":"ci-system","env":"staging","name":"acme-staging-ci-system","revoked":1}
```

Every value above that looks like an identifier is a placeholder. No payload on this page can carry a token value, whatever is substituted in.
