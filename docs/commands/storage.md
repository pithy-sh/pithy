# pithy storage

_The site renders this for readers: [pithy.sh/docs/cli/commands/storage](https://pithy.sh/docs/cli/commands/storage). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up what `pithy add storage` only wired: the per-environment R2 bucket, the `storage-r2-credentials` secret, and the deployed sweep worker that hosts the daily orphan reconciliation.

## Synopsis

```
pithy storage provision [--worker <name>] [--api-token <token>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
pithy storage deprovision [--storage] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

**Both subcommands reach a Cloudflare account.** There is no local mode and no `--env` flag: provisioning spans every managed environment — `staging` and `prod` — in one run.

## Flags

`pithy storage provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `wrangler.jsonc` carries the per-environment `DB` binding and receives the sweep Workflow binding. Required when a project has several |
| `--api-token <token>` | `CLOUDFLARE_API_TOKEN` | The token carried beside the R2 key pair, so the object store can prove bucket access. The default is a broad token; supply an R2-scoped one for production |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | R2 S3 access key id the Worker presigns uploads and downloads with. Made under R2 → Manage API tokens |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair. Passing one of the two without the other is refused |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy storage deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--storage` | `false` | **Irreversible.** Also delete the R2 buckets and every file in them |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | Required with `--storage`: a bucket must be emptied over the S3 protocol before R2 will delete it |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair |
| `--json` | `false` | Machine-readable output |

## What it does

**The R2 key pair is supplied, not minted.** Cloudflare exposes no API for creating one, so it comes from the flags or from `R2_CREDENTIALS` in the account config and is written into the secret as given.

`provision` runs in phases across every managed environment rather than one environment end to end, so a failure creating `prod`'s bucket stops the run before `staging`'s worker is deployed against a half-provisioned account:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain.
2. **Buckets.** Create or reuse each environment's R2 bucket.
3. **Credentials.** Write each environment's `storage-r2-credentials` secret: the account id, the S3 key pair, the scoped token, and the bucket name the object store presigns with. Before the worker, because a worker that boots without its credentials fails on its first multipart abort.
4. **Workers.** Deploy the prebuilt sweep worker per environment, wired to the provisioned bucket.
5. **Bindings.** Write the sweep Workflow binding into the app worker's `wrangler.jsonc`, per environment. `pithy add storage` cannot: wrangler requires both a `name` and a `class_name` on every `workflows` entry, and the deployed name is per project and environment (`<project>-<env>-storage-sweep`). An entry short of either field fails the whole config, so `add` emits none and this run completes it.

An environment is **ready** when its stanza in the app worker's `wrangler.jsonc` carries a `DB` binding with a `database_id` — that is, when `pithy provision --env <name>` has run for it. One that is not is **skipped and reported**, never fatal: standing staging up and proving it before production resources exist is the ordinary bring-up, and this command used to refuse it part way through, naming production, after every environment's bucket and credentials already existed. The decision is made once, from one read, before anything is created. A declared environment with no stanza at all is a different thing and stays a refusal — that is config drift, and `pithy provision --env <name>` does not write a stanza.

If **every** environment is skipped the run exits 1 rather than reporting a success for a run that did nothing, naming each environment and the command that resolves the first.

Each ready environment's deploy still needs its secrets database resolved — `<project>-<env>-secrets`, looked up live, which `pithy secrets provision` creates — and that stays a refusal, because by the time an environment is ready a missing one is a genuine failure rather than a not-yet.

`deprovision` removes the sweep workers. The buckets and their files stay unless `--storage` is passed. With `--storage`, the key pair is resolved **before** the first worker comes down: discovering it missing at the bucket step would leave the workers gone and the buckets standing.

Both subcommands audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy storage provision`

| key | type | meaning |
|---|---|---|
| `command` | `"storage provision"` | The subcommand that produced this line |
| `environments` | array | One entry per environment provisioned, in managed-environment order |
| `environments[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `environments[].bucketName` | string | The R2 bucket objects live in for this environment |
| `skippedEnvironments` | `object[]` | One entry per environment nothing was provisioned for |
| `skippedEnvironments[].env` | `string` | The environment that was skipped |
| `skippedEnvironments[].reason` | `string` | Why — `env.<name> has no DB database_id.` |
| `skippedEnvironments[].action` | `string` | The command that resolves it |

When **every** environment was skipped the line above is still written to stdout — the per-environment structure is the answer, and losing it to the error line would make `--json` less use than the text — and an `{"error":…}` line follows on stderr with exit 1.

`pithy storage deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"storage deprovision"` | The subcommand that produced this line |
| `storageDeleted` | boolean | Whether `--storage` was passed, and therefore whether the buckets and their files were deleted |

A failing run writes `{"error":{…}}` to stderr instead and exits 1 — the same public payload the HTTP surface encodes, with `detail` stripped.

## Errors

Each is a `PithyError`: the problem, then the action.

**The capability is not configured.** No Worker's `pithy.config.ts` composes `storage`.

```
The storage capability is not configured.
Add `storage({ ... })` to pithy.config.ts (run `pithy add storage`).
```

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/storage` missing answers `The storage capability is not installed.` with `pithy add storage`; the package present with one of its own imports unresolved answers `The storage capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The storage capability is installed and will not load.`

**Credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**No Secrets Store id.** The sweep worker decrypts its credentials from it. Both subcommands resolve credentials through the same reader, so `deprovision` is refused without it too, though it writes no secret.

```
The CF Secrets Store id is missing.
Run pithy add secrets to record SECRETS_STORE_ID (the sweep worker decrypts its credentials from it).
```

**Half an R2 key pair**, or none at all.

```
The R2 access-key pair is incomplete.
Pass both --r2-access-key-id and --r2-secret-access-key.
```

```
No R2 S3 credentials were supplied.
Pass --r2-access-key-id and --r2-secret-access-key, or set R2_CREDENTIALS in .dev.vars. Create the pair under R2 → Manage API tokens; Cloudflare has no API for minting one.
```

A malformed `R2_CREDENTIALS` is its own refusal — `R2_CREDENTIALS is not valid JSON.` or `R2_CREDENTIALS is not a valid access-key/secret-key pair.` — rather than a SigV4 fault later.

**The project has no name.** Every resource name this run creates — and `deprovision`'s ability to find them again — derives from it, so it is never guessed.

```
pithy.config.ts has no `name`.
```

**No environment is ready.** Every declared environment was skipped, so nothing was provisioned.

```
No environment is ready — staging and prod have no DB database_id.
Run pithy provision --env staging to create its app database, then run pithy storage provision again.
```

**The app Worker declares an environment it has no stanza for.** Config drift rather than provisioning state, so it is refused rather than skipped.

```
api's wrangler.jsonc has no env.staging stanza.
Add the staging environment to apps/api/wrangler.jsonc with its DB binding.
```

**The secrets database does not exist.**

```
The staging secrets database (acme-staging-secrets) does not exist.
Run `pithy secrets provision` first — the sweep worker reads its credentials from it.
```

## Examples

Provision every environment from `R2_CREDENTIALS` in the account config:

```
$ pithy storage provision
  staging  bucket acme-staging-storage ready, sweep worker deployed
  prod     skipped — env.prod has no DB database_id. Run pithy provision --env prod.
Done.
```

The same run, machine-readable:

```
$ pithy storage provision --json
{"command":"storage provision","environments":[{"env":"staging","bucketName":"acme-staging-storage"}],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"Run pithy provision --env prod."}]}
```

Take the sweep workers down and leave the files alone:

```
$ pithy storage deprovision
Sweep workers removed.
Done.
```

Take everything down, including the bytes:

```
$ pithy storage deprovision --storage --r2-access-key-id $R2_KEY --r2-secret-access-key $R2_SECRET --json
{"command":"storage deprovision","storageDeleted":true}
```
