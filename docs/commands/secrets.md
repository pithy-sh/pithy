# pithy secrets

Declare, write, list, and edit a project's secrets — and stand up the per-environment infrastructure that stores them.

## Synopsis

```bash
pithy secrets create <name> [--env <env>] [--json]
pithy secrets update <name> [--env <env>] [--json]
pithy secrets rm <name> [--env <env>] [--json]
pithy secrets ls [--json]
pithy secrets edit [--json]
pithy secrets provision [--json]
pithy secrets deprovision [--keys] [--json]
```

## Flags

| Subcommand | Flag | Meaning |
|---|---|---|
| `create`, `update`, `rm` | `<name>` (positional, required) | The secret's name — a registry entry. |
| `create`, `update`, `rm` | `--env <env>` | Target environment for an environment-scoped secret: `staging` or `prod`. Not `dev`. |
| `deprovision` | `--keys` | Also delete each environment's master key. Irreversible: every stored secret becomes undecryptable. Default `false`. |
| all | `--json` | Machine-readable output. Default `false`. |

`--env` here is the **managed** set — every environment the root `pithy.config.ts` declares, `["staging", "prod"]` unless it says otherwise — not the three `--env` takes elsewhere. `dev` is local-only, so it is refused with a sentence pointing at `pithy dev`, and an environment the project does not declare is refused by name with the ones that are. A global secret ignores `--env`: a `d1`-backed one reaches every declared environment regardless, and a `cf-secrets-store` one is written once through the last declared environment, since it is a single account-level secret every environment binds.

There is no `--worker`. Every subcommand reads the **project's** registry: each Worker's, merged by secret name.

## What it does

The registry is the definition. `pithy secrets` never invents a name — a secret must be declared by a Worker's secrets capability, and an undeclared one is refused before anything is sent.

**A value never comes from a flag.** `create` and `update` read the value from stdin when it is piped, and from a masked prompt otherwise. A flag would leave a live credential in shell history and in every process list on the machine. Nothing here prints a value back, on any subcommand, in either output mode.

`create`, `update` and `rm` dispatch through the environment's manager Workflow rather than writing storage directly, and each is audited (`secrets/set`, `secrets/rotated`, `secrets/removed`) recording the secret's name and the environments reached — never its value. Which environments a write reaches is the registry's decision, not the flag's: an `environment`-scoped secret reaches exactly the one you named; a `global` one in D1 fans out across every managed environment; a `global` one in the CF Secrets Store is written once, canonically, through `prod`.

`ls` lists the declared names with their routing facts, offline. It reads the registry and nothing else — no credentials, no network.

`edit` is the odd one out, and deliberately: it touches nothing but this machine's dev values at `<config>/<project>/secrets.jsonc`, the file every registry secret's local value lives in as a versioned envelope and the source generation reads. It opens a draft beside the real file, validates what comes back, and writes it atomically at `0600`. **It prints a path and a count, never a name and never a value** — `ls` is what lists names. A draft that will not validate is handed back with the problem printed above it; a draft that is still broken, that the editor abandoned, or that lost a race with another command is kept, and the refusal names its absolute path. Nothing here deletes text it could not write.

`provision` stands up the per-environment infrastructure for every managed environment in order: the manager's own least-privilege token first, then per environment a dedicated D1, a minted master key, the migrated schema, and the deployed manager Worker. Every step is idempotent — running it again is a no-op. `deprovision` reverses it, and keeps the master keys unless `--keys` says otherwise.

Credentials for the last four paragraphs' Cloudflare work come from `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` when the root `pithy.config.ts` names an account — account-scoped, not per project. `provision` and `deprovision` additionally need `SECRETS_STORE_ID`, which `pithy add secrets` records. `PITHY_OFFLINE` refuses ambient credentials outright, so an offline run of a Cloudflare-touching subcommand fails rather than reaching an account nobody named.

## `--json`

One line on stdout. A failure is one `{"error": …}` line on stderr and a non-zero exit.

### `secrets create` · `secrets update` · `secrets rm`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets create"`, `"secrets update"`, or `"secrets delete"` — `rm` reports the mode it ran, which is `delete`. |
| `name` | string | The secret name given on the command line. |
| `environments` | string[] | The managed environments the write reached: `"staging"`, `"prod"`, or both. |

### `secrets ls`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets ls"`. |
| `secrets` | object[] | Every declared name, sorted. |
| `secrets[].name` | string | The registry key — a secret name, or a keyspace. |
| `secrets[].description` | string | The entry's routing facts, joined by ` · `: backend (`d1` or `cf-secrets-store`), then scope (`environment` or `global`), then `rotatable` when it is, then `keyspace` when the entry is keyed. |

A `keyspace` marker is the one entry an operator must not try to set: its members are written per key, in-Worker, by the application that mints them.

### `secrets edit`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets edit"`. |
| `path` | string | The absolute path of `<config>/<project>/secrets.jsonc`. |
| `changed` | boolean | Whether the file was written. `false` for an edit that changed nothing, which is not a failure. |
| `secrets` | number | How many secrets the file holds now. A count — the names are not in this payload. |

### `secrets provision`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets provision"`. |
| `environments` | object[] | One entry per managed environment, in order. |
| `environments[].env` | string | `"staging"` or `"prod"`. |
| `environments[].databaseId` | string | The id of that environment's secrets D1. |
| `environments[].storeId` | string | The Secrets Store id that environment's master key was written to. |

### `secrets deprovision`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets deprovision"`. |
| `keysDeleted` | boolean | Whether `--keys` was passed, and so whether the master keys were deleted with the rest. |

## Errors

- **No secrets capability.** No Worker in the project composes `secrets`, so there is no registry to read.
- **`Secret '<name>' is not declared in the registry.`** Add it to the registry first. Nothing writes a name the registry has never heard of.
- **`Secret '<name>' is a keyspace, not a secret.`** A keyspace has no single value; its members belong to the application that mints them.
- **`Secret '<name>' is environment-scoped — choose an environment.`** Pass `--env staging` or `--env prod`.
- **`--env dev`.** Refused with `--env must be one of staging, prod`, and pointed at `pithy dev` — this writes to a Cloudflare account, and `dev` is local.
- **`Cloudflare credentials are missing.`** Run `pithy init` to record the pair, or export it. Raised by every subcommand that reaches Cloudflare — not by `ls`.
- **`The CF Secrets Store id is missing.`** `provision` and `deprovision` only. Run `pithy add secrets` to record `SECRETS_STORE_ID`.
- **No project name.** Every subcommand that resolves a path or a Workflow requires `name` in the root `pithy.config.ts` and refuses to guess one. A guess would open one checkout's secrets from another's worktree, or dispatch this project's values into another project's manager.
- **`edit` conflicts.** The file changed while you were editing (nothing is written, merge by hand); the editor exited non-zero on changed text (your text is kept, and named); the text came back invalid twice (same).

## Examples

```bash
# List what is declared. Offline, no credentials, no values.
pithy secrets ls --json

# Create a secret. The value is piped, never typed as a flag.
printf '%s' "$THE_VALUE" | pithy secrets create STRIPE_SECRET_KEY --env prod --json

# Update one interactively — a masked prompt asks for the value.
pithy secrets update STRIPE_SECRET_KEY --env prod

# Remove one.
pithy secrets rm OLD_WEBHOOK_SECRET --env staging --json

# Edit this machine's dev values in $EDITOR.
pithy secrets edit
```

```json
{"command":"secrets create","name":"STRIPE_SECRET_KEY","environments":["prod"]}
{"command":"secrets ls","secrets":[{"name":"SESSION_SIGNING_KEY","description":"d1 · environment · rotatable"},{"name":"TENANT_KEYS","description":"d1 · environment · keyspace"}]}
{"command":"secrets edit","path":"/home/you/.config/pithy/acme/secrets.jsonc","changed":true,"secrets":4}
{"command":"secrets provision","environments":[{"env":"staging","databaseId":"<database-id>","storeId":"<store-id>"},{"env":"prod","databaseId":"<database-id>","storeId":"<store-id>"}]}
{"command":"secrets deprovision","keysDeleted":false}
```

No example above contains a value, and none of these payloads can carry one.
