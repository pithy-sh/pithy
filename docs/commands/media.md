# pithy media

_The site renders this for readers: [pithy.sh/docs/cli/commands/media](https://pithy.sh/docs/cli/commands/media). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up what `pithy add media` only wired: the per-environment R2 bucket, the `MEDIA` KV namespace when records live in KV, the two credential secrets, and the deployed media worker that hosts the enrichment Workflows.

## Synopsis

```
pithy media provision [--worker <name>] [--api-token <token>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--r2-api-token <token>] [--json]
pithy media deprovision [--storage] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

**Both subcommands reach a Cloudflare account.** There is no local mode and no `--env` flag: provisioning spans every managed environment — `staging` and `prod` — in one run.

## Flags

`pithy media provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `wrangler.jsonc` carries the per-environment `DB` binding. Required when a project has several |
| `--api-token <token>` | `CLOUDFLARE_API_TOKEN` | The token the media Worker mints Images and Stream direct-upload URLs with. The default is a broad token; supply a scoped Images + Stream one for production |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | R2 S3 access key id the Worker presigns uploads and downloads with. Made under R2 → Manage API tokens |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair. Passing one of the two without the other is refused |
| `--r2-api-token <token>` | `CLOUDFLARE_API_TOKEN` | The token carried beside the R2 key pair so the object store can prove bucket access |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy media deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--storage` | `false` | **Irreversible.** Also delete the R2 bucket with every object in it, and the `MEDIA` KV namespace |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | Required with `--storage`: a bucket must be emptied over the S3 protocol before R2 will delete it |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair |
| `--json` | `false` | Machine-readable output |

## What it does

**The credentials are supplied, not minted.** Cloudflare exposes no API for creating an R2 S3 access-key pair, and the permission catalog carries no Images or Stream keys. The pair and the scoped token come from the flags or from `R2_CREDENTIALS` in the account config, and are written into the secret as given.

`provision` runs in phases across every managed environment rather than one environment end to end, so a failure in `prod` stops the run before `staging` is deployed against a half-provisioned account:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain.
2. **Resources.** Create or reuse each environment's R2 bucket, and its `MEDIA` KV namespace when the capability's `recordStore` is `kv`. In D1 record mode no namespace is created and the binding is dropped rather than pointed at a namespace that never existed.
3. **Credentials.** Write each environment's two secrets. Two, because there are two owners: `media-storage-credentials` is media's Images + Stream token, and `media-r2-credentials` belongs to `@pithy-sh/storage`'s `ObjectStore`, which media presigns through and whose key pair media never sees.
4. **Workers.** Deploy the prebuilt media worker per ready environment, wired to the resources the secrets already name.

An environment is **ready** when its stanza in the app worker's `wrangler.jsonc` carries a `DB` binding with a `database_id` — that is, when `pithy provision --env <name>` has run for it. One that is not is **skipped and reported**, never fatal: standing staging up and proving it before production resources exist is the ordinary bring-up, and this command used to refuse it part way through, naming production, after every environment's bucket, namespace and credentials already existed. The decision is made once, from one read, before anything is created. A declared environment with no stanza at all is a different thing and stays a refusal — that is config drift, and `pithy provision --env <name>` does not write a stanza.

If **every** environment is skipped the run exits 1 rather than reporting a success for a run that did nothing, naming each environment and the command that resolves the first.

Each ready environment's deploy still needs its secrets database resolved — `<project>-<env>-secrets`, looked up live, which `pithy secrets provision` creates — and that stays a refusal, because by the time an environment is ready a missing one is a genuine failure rather than a not-yet.

`deprovision` removes the media workers. The bucket, its objects, and the namespace stay unless `--storage` is passed. With `--storage`, the key pair is resolved **before** the first worker comes down: discovering it missing at the bucket step would leave the workers gone and the bucket standing.

Both subcommands audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy media provision`

| key | type | meaning |
|---|---|---|
| `command` | `"media provision"` | The subcommand that produced this line |
| `environments` | array | One entry per environment provisioned, in managed-environment order |
| `environments[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `environments[].bucketName` | string | The R2 bucket media objects live in for this environment |
| `environments[].kvNamespaceId` | string \| null | The `MEDIA` KV namespace id, or `null` when records live in D1 and the binding is dropped |
| `skippedEnvironments` | `object[]` | One entry per environment nothing was provisioned for |
| `skippedEnvironments[].env` | `string` | The environment that was skipped |
| `skippedEnvironments[].reason` | `string` | Why — `env.<name> has no DB database_id.` |
| `skippedEnvironments[].action` | `string` | The command that resolves it |

When **every** environment was skipped the line above is still written to stdout — the per-environment structure is the answer, and losing it to the error line would make `--json` less use than the text — and an `{"error":…}` line follows on stderr with exit 1.

`pithy media deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"media deprovision"` | The subcommand that produced this line |
| `storageDeleted` | boolean | Whether `--storage` was passed, and therefore whether the bucket, its objects, and the namespace were deleted |

A failing run writes `{"error":{…}}` to stderr instead and exits 1 — the same public payload the HTTP surface encodes, with `detail` stripped.

## Errors

Each is a `PithyError`: the problem, then the action.

**The capability is not configured.** No Worker's `pithy.config.ts` composes `media`.

```
The media capability is not configured.
Add `media({ ... })` to pithy.config.ts (run `pithy add media`).
```

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/media` missing answers `The media capability is not installed.` with `pithy add media`; the package present with one of its own imports unresolved answers `The media capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The media capability is installed and will not load.`

**Credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**No Secrets Store id.** The media worker decrypts its credentials from it. Both subcommands resolve credentials through the same reader, so `deprovision` is refused without it too, though it writes no secret.

```
The CF Secrets Store id is missing.
Run pithy add secrets to record SECRETS_STORE_ID (the media worker decrypts its credentials from it).
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

**The project has no name.** Every resource name this run creates — and `deprovision`'s ability to find them again — derives from it, so it is never guessed.

```
pithy.config.ts has no `name`.
```

**No environment is ready.** Every declared environment was skipped, so nothing was provisioned.

```
No environment is ready — staging and prod have no DB database_id.
Run pithy provision --env staging to create its app database, then run pithy media provision again.
```

**The app Worker declares an environment it has no stanza for.** Config drift rather than provisioning state, so it is refused rather than skipped.

```
api's wrangler.jsonc has no env.prod stanza.
Add the prod environment to apps/api/wrangler.jsonc with its DB binding.
```

**The secrets database does not exist.**

```
The prod secrets database (acme-prod-secrets) does not exist.
Run `pithy secrets provision` first — the media worker reads its credentials from it.
```

## Examples

Provision every environment with a scoped Images + Stream token:

```
$ pithy media provision --api-token $MEDIA_TOKEN
  staging  bucket acme-staging-media and its MEDIA namespace ready, worker deployed
  prod     bucket acme-prod-media and its MEDIA namespace ready, worker deployed
Done.
```

The same run, machine-readable, in D1 record mode:

```
$ pithy media provision --json
{"command":"media provision","environments":[{"env":"staging","bucketName":"acme-staging-media","kvNamespaceId":null}],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"Run pithy provision --env prod."}]}
```

Take the workers down and leave the objects alone:

```
$ pithy media deprovision
Media workers removed.
Done.
```

Take everything down, including the bytes:

```
$ pithy media deprovision --storage --json
{"command":"media deprovision","storageDeleted":true}
```
