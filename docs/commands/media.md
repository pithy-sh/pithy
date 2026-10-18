# pithy media

_The site renders this for readers: [pithy.sh/docs/cli/commands/media](https://pithy.sh/docs/cli/commands/media). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up what `pithy add media` only wired: the per-environment R2 bucket, the two credential secrets, the two signing keys private media is delivered through, and the deployed media worker that hosts the enrichment Workflows.

## Synopsis

```
pithy media provision [--worker <name>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
pithy media deprovision --env <environment> [--storage] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

**Its Worker deploy is gated.** The Worker is deployed carrying a stamp naming the package version and a hash of its resolved configuration, and a run whose stamp matches both ships nothing. Anything the gate cannot establish — no Worker, no stamp, an unreachable account — deploys. `pithy deploy --env <env>` ships the same Worker without provisioning anything else, and `pithy deploy --env <env> --kit --force` re-uploads it regardless. See [`pithy deploy`](./deploy.md).

**Both subcommands reach a Cloudflare account.** There is no local mode. `provision` has no `--env` flag: it spans every managed environment — `staging` and `prod` — in one run. `deprovision` is the opposite, and requires one: it tears down exactly the environment named.

## Flags

`pithy media provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `media(...)` registration is provisioned, and whose `wrangler.jsonc` carries the per-environment `DB` binding. Required when a project has several |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | R2 S3 access key id the Worker presigns uploads and downloads with. Made under R2 → Manage API tokens |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair. Passing one of the two without the other is refused |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy media deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--env <environment>` | none — required | The one environment to tear down, declared in `pithy.config.ts`. With none, or one not declared, it refuses and lists the environments it could act on |
| `--storage` | `false` | **Irreversible.** Also delete that environment's R2 bucket with every object in it |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | Required with `--storage`: a bucket must be emptied over the S3 protocol before R2 will delete it |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair |
| `--json` | `false` | Machine-readable output |

## What it does

**No Images or Stream token is asked for.** Media mints uploads, changes signing and reads what was served with the application's one `runtime` token, which `pithy secrets provision` mints per environment ([`TOKENS.md`](../TOKENS.md)). The run refuses before it writes anything, while any environment's Secrets Store holds no runtime token, and names `pithy token mint runtime --env <env>`: a bundle rewritten first would break a Worker still on the old kit. A project storing both types in R2 calls Cloudflare for nothing, so its media host binds no runtime token and the run asks for none.

**The R2 pair is supplied, not minted.** Cloudflare exposes no API for creating an R2 S3 access-key pair. It comes from the flags or from `R2_CREDENTIALS` in the account config, and is written into the secret as given. It is the object store's credential, outside the one-token rule. No Cloudflare API token is stored beside it: the object store signs every call with the pair.

`provision` runs in phases across every managed environment rather than one environment end to end, so a failure in `prod` stops the run before `staging` is deployed against a half-provisioned account:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain. Then, while images live in Cloudflare Images and `visibility.allowed` admits anything but `public`, refuse if any Images variant is set to `neverRequireSignedURLs`, naming each: such a variant serves a private image to anyone holding its URL. Nothing has been created yet.
2. **Resources.** Create or reuse each environment's R2 bucket. Records live in D1, so no KV namespace is created.
3. **Credentials.** Write each environment's two secrets. Two, because there are two owners: `media-storage-credentials` is media's account id and nothing else, and `media-r2-credentials` belongs to `@pithy-sh/storage`'s `ObjectStore`, which media presigns through and whose key pair media never sees.
4. **Signing keys.** Where some record could be private, write `media-images-signing-key` — the account's Images URL-signing key, read as found, or created as `pithy` when the account has none — and `media-stream-signing-key`, a Stream signing key. Cloudflare hands a Stream key's private half back once, at creation, so one is created only when the environment holds none; a re-run keeps the stored key. A non-public Images or Stream asset is uploaded with `requireSignedURLs`, and the Worker signs a short-lived URL with these for a caller who may read it.
5. **Workers.** Deploy the prebuilt media worker per ready environment, wired to the resources the secrets already name.

An environment is **ready** when its stanza in the app worker's `wrangler.jsonc` carries a `DB` binding with a `database_id` — that is, when `pithy provision --env <name>` has run for it. One that is not is **skipped and reported**, never fatal: standing staging up and proving it before production resources exist is the ordinary bring-up, and this command used to refuse it part way through, naming production, after every environment's bucket and credentials already existed. The decision is made once, from one read, before anything is created. A declared environment with no stanza at all is a different thing and stays a refusal — that is config drift, and `pithy provision --env <name>` does not write a stanza.

If **every** environment is skipped the run exits 3 (`core/precondition_failed`, with a `fix`) rather than reporting a success for a run that did nothing, naming each environment and the command that resolves the first.

Each ready environment's deploy still needs its secrets database resolved — `<project>-<env>-secrets`, looked up live, which `pithy secrets provision` creates — and that stays a refusal, because by the time an environment is ready a missing one is a genuine failure rather than a not-yet.

`deprovision` removes **one named environment's** media worker. Its bucket and its objects stay unless `--storage` is passed. There is no default environment and no "all": it used to walk every declared environment, so a `--storage` run meant for staging deleted production's bucket with it. Named nothing, or something undeclared, it refuses before any credential is read and lists what could be named. `--env dev` is pointed at `pithy dev` instead. With `--storage`, the key pair is resolved **before** the worker comes down: discovering it missing at the bucket step would leave the worker gone and the bucket standing.

The teardown runs from the project's own `@pithy-sh/media`, and a copy from before this walked every environment. So the command hands it a deprovisioner that deletes only the named environment's worker, and its bucket only with `--storage`. A copy that reaches further is refused at the reach, with `Update @pithy-sh/media to match this CLI, then run it again.`

Both subcommands audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy media provision`

| key | type | meaning |
|---|---|---|
| `command` | `"media provision"` | The subcommand that produced this line |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `environments` | array | One entry per environment provisioned, in managed-environment order |
| `environments[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `environments[].bucketName` | string | The R2 bucket media objects live in for this environment |
| `skippedEnvironments` | `object[]` | One entry per environment nothing was provisioned for |
| `skippedEnvironments[].env` | `string` | The environment that was skipped |
| `skippedEnvironments[].reason` | `string` | Why — `env.<name> has no DB database_id.` |
| `skippedEnvironments[].action` | `string` | The command that resolves it |
| `exitCode` | integer | The status the run exits with: `0`. A run that provisions nothing writes no report |

**One outcome, never two.** A run that went ahead writes this report alone and exits 0, whether or not some environments were skipped — `exitCode` says so, and it matches `$?`. A run in which **every** environment was skipped provisioned no environment, so it writes nothing on stdout: the `{"error":…}` line on stderr is the whole answer, exit 3, with the provisioning command as its `fix`. `media provision` is not one of the commands whose report is the answer to a failure (`docs/CLI.md` §3.8).

```
$ pithy media provision --worker api --json
{"command":"media provision","schemaVersion":2,"environments":[{"env":"staging","bucketName":"acme-staging-media"}],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix."}],"exitCode":0}
$ echo $?
0
```

```
$ pithy media provision --worker api --json
{"error":{"code":"core/precondition_failed","status":412,"message":"No environment is ready — staging and prod have no DB database_id.","action":"Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy media provision --json --worker api` again.","exit":3,"retryable":false,"fix":"pithy provision --env staging --yes"}}
$ echo $?
3
```

The second line is on stderr, and stdout is empty.

`pithy media deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"media deprovision"` | The subcommand that produced this line |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `env` | string | The one environment torn down — the value of `--env` |
| `storageDeleted` | boolean | Whether `--storage` was passed, and therefore whether that environment's bucket and its objects were deleted |

A failing run writes `{"error":{…}}` to stderr instead and exits by its kind (`docs/CLI.md` §3.8) — the same public payload the HTTP surface encodes, with `detail` stripped, plus `exit`, `retryable` and, where the cause is known, `fix`.

## Errors

Each is a `PithyError`: the problem, then the action.

**The Worker does not compose `media`.** The target, `--worker` or the project's only Worker, has no `media(...)` registration. The config is read off the Worker the run writes into and never off a sibling: the media host is deployed against that Worker's app database, where its tables live.

```
<worker> does not compose the media capability.
Add `media({ ... })` to <worker>'s pithy.config.ts (run `pithy add media --worker <worker> --with-prerequisites`), or name the Worker that composes it with --worker.
```

Named with `--worker`, it is a usage error, exit 2: another `--worker` is the fix. The project's only Worker, unnamed, is `core/precondition_failed`, exit 3, with that same command as its `fix`, `<worker>` being the Worker's `apps/` directory. `--with-prerequisites` is there because media declares `secrets` and that Worker does not compose it yet; a Worker that already does is named without it. The command is built from media's manifest — the installed one, or the kit's own when none is installed — so the line and the `fix` cannot disagree.

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/media` missing answers `The media capability is not installed.` with `pithy add media --worker <w> --with-prerequisites` — read from the kit's own manifest, since none is installed — and, in a project with several Workers, one such command for each Worker; a project with no Worker is told to create one with `pithy worker add` first; the package present with a dependency of its own not installed answers `The media capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The media capability is installed and will not load.`, and so does one whose import names something no install provides: a `#` import its own imports map lacks, or a `node:` module this runtime does not have. A path an installed package does not have, or does not export, answers `The media capability is installed but incomplete.` No install fixes any of those, so the action never offers one, and it names the package that wrote the import.

**Credentials are missing.**

```
Cloudflare credentials are missing.
Export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this project's account, then run this again.
```

**No Secrets Store id.** The media worker decrypts its credentials from it. Both subcommands resolve credentials through the same reader, so `deprovision` is refused without it too, though it writes no secret.

```
The CF Secrets Store id is missing.
Run `pithy add secrets --worker <worker>` to record SECRETS_STORE_ID (the media worker decrypts its credentials from it).
```

`<worker>` is a Worker composing `secrets`, by its `apps/` directory — the ones that do when any does, every Worker when none does. In a project with several Workers the action names one command per Worker — ``Run `pithy add secrets --worker api` or `pithy add secrets --worker web` to record …`` — because a bare `pithy add secrets` is refused there.

**Half an R2 key pair**, or none at all.

```
The R2 access-key pair is incomplete.
Pass both --r2-access-key-id and --r2-secret-access-key.
```

```
No R2 S3 credentials were supplied.
Pass --r2-access-key-id and --r2-secret-access-key, or set R2_CREDENTIALS in .dev.vars. Create the pair under R2 → Manage API tokens; Cloudflare has no API for minting one.
```

**The project has no name.** Every resource name this run creates — and `deprovision`'s ability to find them again — derives from it, so it is never guessed. It is `core/precondition_failed`, exit 3: the call is right and the project is missing what it depends on.

```
pithy.config.ts has no `name`.
```

**No environment is ready.** Every declared environment was skipped, so nothing was provisioned.

```
No environment is ready — staging and prod have no DB database_id.
Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy media provision --worker api` again.
```

**The app Worker declares an environment it has no stanza for.** Config drift rather than provisioning state, so it is refused rather than skipped.

```
api's wrangler.jsonc has no env.prod stanza.
Add the prod environment to apps/api/wrangler.jsonc with its DB binding.
```

**An Images variant serves unsigned.** While some record could be private, a variant set to `neverRequireSignedURLs` would deliver it to anyone.

```
Cloudflare Images variant `thumb` serves every image unsigned, so a private image would be public through it.
Turn off neverRequireSignedURLs on each in Images → Variants, or narrow visibility.allowed to ["public"] in media({ … }), then re-run.
```

**The secrets database does not exist.**

```
The prod secrets database (acme-prod-secrets) does not exist.
`pithy secrets provision` runs against every environment, production included. That is a person's decision, not a fix. It creates this database — the media worker reads its credentials from it.
```

## Examples

Provision every environment:

```
$ pithy media provision
  staging  bucket acme-staging-media ready, worker deployed
  prod     bucket acme-prod-media ready, worker deployed
Done.
```

The same run, machine-readable:

```
$ pithy media provision --json
{"command":"media provision","schemaVersion":2,"environments":[{"env":"staging","bucketName":"acme-staging-media"}],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix."}],"exitCode":0}
```

Take staging's worker down and leave the objects alone:

```
$ pithy media deprovision --env staging
staging: media worker removed.
Done.
```

Take all of staging down, including the bytes. Production is untouched:

```
$ pithy media deprovision --env staging --storage --json
{"command":"media deprovision","schemaVersion":1,"env":"staging","storageDeleted":true}
```
