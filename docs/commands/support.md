# pithy support

_The site renders this for readers: [pithy.sh/docs/cli/commands/support](https://pithy.sh/docs/cli/commands/support). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up the support inbox: the R2 bucket attachments and raw messages live in, the per-environment classification worker, the full-text index, and — only when you name all three parts — the Email Routing rule that delivers the support address to your app worker.

## Synopsis

```
pithy support provision [--worker <name>] [--routing-zone <zone-id>] [--inbound-address <address>] [--app-worker <name>] [--json]
pithy support deprovision [--worker <name>] [--storage] [--routing-zone <zone-id>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

**Both subcommands reach a Cloudflare account.** There is no local mode and no `--env` flag: provisioning spans every managed environment — `staging` and `prod` — in one run. Unlike `pithy email` and `pithy media`, no Secrets Store id is needed: the classification worker binds `DB` and `AI` and holds no credential to decrypt.

## Flags

`pithy support provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `wrangler.jsonc` carries the per-environment `DB` binding. Required when a project has several |
| `--routing-zone <zone-id>` | — | Cloudflare Zone ID of the (sub)domain receiving the mail. Email Routing must already be enabled on it |
| `--inbound-address <address>` | — | The exact recipient address the rule matches, e.g. `support@help.example.com`. It must also be listed in `support()`'s `inboundAddresses`, which is what claims it |
| `--app-worker <name>` | — | Deployed name of the production app worker running `createEntrypoint` with the support capability composed |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy support deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | — | The app Worker whose `wrangler.jsonc` names the database the audit trail is written to |
| `--storage` | `false` | **Irreversible.** Also delete the R2 bucket with every attachment and raw message in it — this is your support history |
| `--routing-zone <zone-id>` | — | The zone the inbound rule lives on. Without it the rule is left in place and mail keeps arriving |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | Required with `--storage`: a bucket must be emptied over the S3 protocol before R2 will delete it |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair |
| `--json` | `false` | Machine-readable output |

**The three routing flags are all or nothing.** Pass all three and the rule is created; pass none and everything else provisions without one. Pass one or two and the run is refused before anything is created — an operator who passed two of three asked for a rule, and provisioning everything but the step that delivers the mail would look like success and receive nothing.

The refusal exists because enabling Email Routing on a zone points its MX at Cloudflare. A rule created on the wrong zone moves an adopter's real inbound mail off their existing provider, which is not a mistake a provisioning command gets to make on somebody's behalf. Use a subdomain zone, never your apex.

## What it does

`provision`, in order — and the order is the inverse of how it fails:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain.
2. **Bucket.** Create or reuse `<project>-global-support`. One bucket for the project, not one per environment: the `SUPPORT_BUCKET` binding hangs off the app worker that receives the mail, and each environment's `wrangler.jsonc` points at it by name. When the capability is configured with attachments off and no raw retention, no bucket is created and the step reports `skipped`.
3. **Workers.** Deploy the prebuilt classification worker for every managed environment. It reads a message and writes a label over the `AI` binding.
4. **Search index.** Create or drop the full-text index in each environment's app database to match `search.fts`. A provisioning step rather than a migration, because the index is derived — every row in it comes from `pithy_support_messages`. A newly created index is backfilled immediately, so the inbox never answers "no matches" for a term plainly in a body.
5. **Routing rule.** Last, and only with all three routing flags. Creating it first would start delivering mail to a Worker whose classification host is not deployed yet — a window in which real customer messages arrive and stay uncategorized with nothing to say why.

Each environment's deploy needs the app `DB` id from that environment's stanza in the app Worker's `wrangler.jsonc`. A missing stanza or id is refused rather than deploying a worker that would write its classifications into nothing.

`deprovision` removes the routing rule (only with `--routing-zone`) and the classification workers. The bucket stays unless `--storage` is passed, and with it the key pair is resolved **before** the first worker comes down: discovering it missing at the bucket step would leave the workers gone and the bucket standing.

Both subcommands audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy support provision`

| key | type | meaning |
|---|---|---|
| `command` | `"support provision"` | The subcommand that produced this line |
| `bucket` | object | The R2 bucket, and what happened to it |
| `bucket.bucket` | string | The bucket name — `<project>-global-support`. Reported even when the step was skipped, so the name is always readable |
| `bucket.created` | boolean | True only when this run created it. False when it already existed, and false when skipped |
| `bucket.skipped` | boolean | True when attachments are off and raw retention is off, so no bucket was wanted |
| `environments` | array of `"staging" \| "prod"` | The environments a classification worker was deployed for |
| `search` | array | What the full-text index did, per environment |
| `search[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `search[].created` | boolean | The index was created and backfilled in this run |
| `search[].dropped` | boolean | The index was dropped in this run. Both false means it already matched the config |
| `routing` | object | What happened to the inbound Email Routing rule |
| `routing.created` | boolean | True only when this run created the rule. False when it already existed |
| `routing.skipped` | boolean | True when no routing flags were supplied, so no rule was made |

`pithy support deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"support deprovision"` | The subcommand that produced this line |
| `storageDeleted` | boolean | Whether `--storage` was passed, and therefore whether the bucket and everything in it was deleted |
| `routingZone` | string \| null | The zone id the rule was removed from, or `null` when `--routing-zone` was not passed and the rule was left in place |

A failing run writes `{"error":{…}}` to stderr instead and exits 1 — the same public payload the HTTP surface encodes, with `detail` stripped.

## Errors

Each is a `PithyError`: the problem, then the action.

**Incomplete routing flags.**

```
The inbound routing options are incomplete.
Pass --routing-zone, --inbound-address, and --app-worker together, or none of them.
```

**The capability is not configured.** No Worker's `pithy.config.ts` composes `support`.

```
The support capability is not configured.
Add `support({ ... })` to a worker's pithy.config.ts (run `pithy add support`).
```

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/support` missing answers `The support capability is not installed.` with `pithy add support`; the package present with one of its own imports unresolved answers `The support capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The support capability is installed and will not load.`

**Credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**The project has no name.** The bucket is found by name and reused, so a guessed name would adopt another project's inbox.

```
pithy.config.ts has no `name`.
```

**The app Worker's environment is not wired.**

```
api's wrangler.jsonc has no env.prod stanza.
Add the prod environment to apps/api/wrangler.jsonc with its DB binding.
```

**Half an R2 key pair with `--storage`**, or none at all — `The R2 access-key pair is incomplete.` and `No R2 S3 credentials were supplied.`, both refused before a worker comes down.

**Several Workers and no `--worker`.** The resolution error `pithy add` raises, naming the Workers it found.

## Examples

Provision everything but the rule, then add it once the zone is decided:

```
$ pithy support provision
Bucket acme-global-support ready.
2 classification workers deployed.
Search index created in staging, prod.
No routing rule. Pass --routing-zone, --inbound-address, and --app-worker to create one.
Done.
```

With routing, machine-readable:

```
$ pithy support provision --routing-zone 0a1b2c3d --inbound-address support@help.example.com --app-worker acme-prod --json
{"command":"support provision","bucket":{"bucket":"acme-global-support","created":false,"skipped":false},"environments":["staging","prod"],"routing":{"created":true,"skipped":false},"search":[{"env":"staging","created":false,"dropped":false},{"env":"prod","created":false,"dropped":false}]}
```

Take the workers down but keep the history and the rule:

```
$ pithy support deprovision
Support workers removed.
The routing rule was left in place. Pass --routing-zone to remove it.
Done.
```

Take the lot down, mail included:

```
$ pithy support deprovision --routing-zone 0a1b2c3d --storage --json
{"command":"support deprovision","storageDeleted":true,"routingZone":"0a1b2c3d"}
```
