# pithy support

_The site renders this for readers: [pithy.sh/docs/cli/commands/support](https://pithy.sh/docs/cli/commands/support). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up the support inbox: the R2 bucket attachments and raw messages live in, the per-environment classification worker, the full-text index, the semantic message index when `search.semantic` is on, and, per environment, the Email Routing rule that delivers that environment's support address to its app worker.

## Synopsis

```
pithy support provision [--worker <name>] [--routing-zone <zone-id>] [--inbound-address <address>] [--app-worker <name>] [--json]
pithy support deprovision --env <environment> [--worker <name>] [--storage] [--routing-zone <zone-id>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

**Its Worker deploy is gated.** The Worker is deployed carrying a stamp naming the package version and a hash of its resolved configuration, and a run whose stamp matches both ships nothing. Anything the gate cannot establish — no Worker, no stamp, an unreachable account — deploys. `pithy deploy --env <env>` ships the same Worker without provisioning anything else, and `pithy deploy --env <env> --kit --force` re-uploads it regardless. See [`pithy deploy`](./deploy.md).

**Both subcommands reach a Cloudflare account.** There is no local mode. `provision` has no `--env` flag: it spans every managed environment — `staging` and `prod` — in one run. `deprovision` is the opposite, and requires one: it tears down exactly the environment named. Unlike `pithy email` and `pithy media`, no Secrets Store id is needed: the classification worker binds `DB` and `AI` and holds no credential to decrypt.

## Flags

`pithy support provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `support(...)` registration is provisioned, and whose `wrangler.jsonc` carries the per-environment `DB` binding. Required when a project has several |
| `--routing-zone <zone-id>` | derived | Override. The Zone ID of the zone that contains the address's domain: for `help.example.com`, the parent zone `example.com`, where Email Routing for the subdomain is set up. Email Routing must already be enabled for the domain |
| `--inbound-address <address>` | derived | Override. The exact recipient address the rule matches, e.g. `support@help.example.com`. It must also be listed in `support()`'s `inboundAddresses`, which is what claims it |
| `--app-worker <name>` | derived | Override. Deployed name of the app worker running `createEntrypoint` with the support capability composed |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy support deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--env <environment>` | none — required | The one environment to tear down, declared in `pithy.config.ts`. With none, or one not declared, it refuses and lists the environments it could act on |
| `--worker <name>` | — | The app Worker whose `wrangler.jsonc` names the database the audit trail is written to |
| `--storage` | `false` | **Irreversible.** Also delete the R2 bucket with every attachment and raw message in it — this is your support history. Only the last environment's teardown may |
| `--routing-zone <zone-id>` | — | Also remove the project-global rule the three provision flags created, from this zone. Without it that rule is left in place. Only the last environment's teardown may. The environment's own rule is removed either way |
| `--r2-access-key-id <id>` | `R2_CREDENTIALS` | Required with `--storage`: a bucket must be emptied over the S3 protocol before R2 will delete it |
| `--r2-secret-access-key <key>` | `R2_CREDENTIALS` | The secret half of the pair |
| `--json` | `false` | Machine-readable output |

## Routing

**With no routing flag, each environment's address is routed by itself.** For every ready environment, `provision` composes that environment's `pithy.config.ts`, which may read `compositionEnvironment()`, so the address can differ per environment, and reads support's `inboundAddresses`. For each address:

1. **The zone** is the active zone on the account whose name is the longest suffix of the address's domain. `support@help.example.com` lives in `example.com`'s zone: Email Routing for a subdomain is set up on its parent zone, so a subdomain is usually not a zone of its own. An address whose domain no zone the token can list holds is refused, naming the domain: the account may not hold it, or the token may not be granted Zone Read on it.
2. **Email Routing must be enabled for the domain.** The zone's own Email Routing settings must say it is enabled, for the apex and a subdomain alike. A subdomain must also pass the zone's DNS check for it, listing no missing record; a check that answers in any other shape, a bare record list or no result, is refused rather than read as a pass. **It is never enabled here.** Enabling it moves the domain's MX, and that stays your act. Off, the environment is refused, naming the domain and where to turn it on, and no rule is made.
3. **The Worker** is the one `pithy deploy` names for the environment: the name its stanza in the app Worker's `wrangler.jsonc` declares, `<project>-<env>-<worker>` as `pithy init` writes it.
4. **The rule** matches the exact address and sends it to that Worker. Only enabled rules claim mail, so only they are weighed. When every enabled rule claiming the address already sends it there, nothing changes, whatever they are named. An existing rule for the exact address is taken over only when it is the sole enabled claim: it is updated to send the address to the Worker, keeping its name. When more than one enabled rule claims the address and any sends it elsewhere, the environment is refused, naming the rules, and nothing changes. A disabled rule is never re-enabled; with no enabled claim, `<project>-<env>-support-inbound` is created beside it.

**The permissions it takes.** Every call routing makes is zone-level: Zone Read to find the zone, Zone Settings Read for the Email Routing settings and DNS check, and Email Routing Rules Write for the rule, each on the zone holding the address. `pithy token mint ci-system` grants the three on exactly those zones, and a signed-in session asks for them. A token Cloudflare refuses any of them is a refusal for that environment, naming the three, and every other environment still routes. See [`TOKENS.md`](../TOKENS.md).

**Only on an account the project claims.** A rule is made, updated or removed only when `pithy.config.ts` names the account (`cloudflare.accountId`, or `cloudflare.accountName`). On an account only the environment names, `provision` refuses every derived route, saying why, and `deprovision` refuses before anything is deleted.

A refusal is reported and the run goes on: every other environment is still routed, and the run still exits 0 when one was provisioned. An environment whose composition claims no address is `skipped`. An address two environments both claim is refused for both, because one exact-address rule sends it to one Worker: give each environment its own address, or use the flags.

**The three routing flags are an override, and all or nothing.** Pass all three and they replace the derivation with exactly the rule they describe: one project-global rule named `<project>-global-support-inbound`, on the zone named. They are held to the same checks a derived route is: an account the project claims, a zone the token can list, and Email Routing enabled for the address's domain. Pass one or two and the run is refused before anything is created: an operator who passed two of three asked for a rule, and routing something else would look like success and deliver elsewhere.

## What it does

`provision`, in order — and the order is the inverse of how it fails:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain.
2. **Bucket.** Create or reuse `<project>-global-support`. One bucket for the project, not one per environment: the `SUPPORT_BUCKET` binding hangs off the app worker that receives the mail, and every declared environment's stanza points at that one name — `pithy provision --env <name>` writes the `bucket_name`, and it composes it from the same declaration this command does (`scope: "global"`, `resource: "support"`, in `@pithy-sh/support`'s manifest). That was not true before #513: `provision` composed `<project>-<env>-support-bucket` from the binding name alone, created it, and wrote it into the stanza — so **the per-environment bucket is the one holding your attachments and raw messages**, this global one is the empty side of the split, and `deprovision --storage` has been deleting the empty one. `pithy doctor`'s `shared:` section reports a project still carrying the old names, and says which way round to fix it. When the capability is configured with attachments off and no raw retention, no bucket is created and the step reports `skipped`.

   **Upgrading a project that already has both: copy first, repoint second.** `pithy provision --env <name>` changes which bucket the binding names; it moves no object, and R2 has no rename. Sync each `<project>-<env>-support-bucket` into `<project>-global-support` over R2's S3 endpoint — with the key pair from **R2 → Manage API tokens**, because a Cloudflare API token cannot do an S3 copy — and only then provision. Repointing first does not delete anything, but it makes every stored attachment and raw message unreachable through the app on the spot, and leaves them in a bucket `deprovision --storage` will never touch.
3. **Message index.** With `search.semantic` on, create `<project>-<env>-support-messages` in Vectorize for every **ready** environment, before the worker that binds it is deployed: a deploy that binds an index nobody created fails. 1024 components and `cosine` for the default `@cf/baai/bge-m3`; a `{ model, dimensions }` of your own sets the width. An index that exists is reused, and one that exists at another shape is refused rather than queried in the wrong space. With it off, nothing happens here. See [Search](#search).
4. **Workers.** Deploy the prebuilt classification worker for every **ready** environment. It reads a message and writes a label over the `AI` binding, and with `search.semantic` on it embeds the message into the index too. It also hosts the reprocess Workflow `pithy vector reprocess --index support-messages` starts.
5. **Search index.** Create or drop the full-text index **and its three triggers** in each environment's app database to match `search.fts`, which is on by default. Run it after every upgrade: until it has, search is the `LIKE` fallback and `pithy doctor` names the environment. A provisioning step rather than a migration, because the index is derived — every row in it comes from `pithy_support_messages` — and because a `CREATE TRIGGER` composed conditionally on a config flag is what Kysely reads as ledger corruption. A newly created index is backfilled immediately, so the inbox never answers "no matches" for a term plainly in a body. `pithy backup` leaves the index out, and `pithy restore` rebuilds it with this same step.

   The triggers are what keeps the index in step: an `AFTER INSERT`, an `AFTER UPDATE` and an `AFTER DELETE` on `pithy_support_messages`, so a message is indexed because it was written rather than because the code that wrote it remembered. **The durability contract is the inverse of what it was.** A trigger runs inside the message's own statement, so a failure in its body takes the message write down with it — where the old per-call-site index write logged a warning and carried on. That swallow existed because a second round trip to a separate table can fail on its own; inside one statement it cannot, and the one thing left that can — the index table being absent — is what dropping the pair together prevents.

   **Re-run this after upgrading `@pithy-sh/support`.** A database whose table is already there and whose triggers are not is repaired and backfilled here, and reported as `search index triggers restored and backfilled`. `pithy doctor`'s `Support search:` block names any environment still in that state.
6. **Message index, settled.** An index that holds nothing yet is **backfilled once**: one step 3 created, or one that exists while inbound mail does and no message carries a stamp — what a run that failed after creating the index leaves, so re-running provision finishes the job. The run starts the reprocess Workflow over every inbound message and does not wait for it — re-embedding an inbox is a Workflow's job. An index holding any stamp is never re-embedded here; that is `pithy vector reprocess`. With `search.semantic` off, an index that exists is **dropped**, after the deploy that stopped binding it, with the model stamps in `pithy_support_embeddings` that named its vectors. Looking for it is the only Vectorize call a run with semantic search off makes, and a token without a Vectorize grant, or an account without the paid Workers plan Vectorize needs, answers it with nothing to drop rather than failing the run. Either way the app Worker's `wrangler.jsonc` follows: the `SUPPORT_VECTORIZE` entry is written into each environment's stanza while the index exists, and taken out when it is dropped, because a binding to a deleted index fails the next deploy.
7. **Routing rules.** Last, and only when at least one classification host went up: each ready environment's own, or the one the flags name. See [Routing](#routing). Creating it first would start delivering mail to a Worker whose classification host is not deployed yet — a window in which real customer messages arrive and stay uncategorized with nothing to say why; over a run that deployed nothing, that window is the whole project.

An environment is **ready** when its stanza in the app Worker's `wrangler.jsonc` carries a `DB` binding with a `database_id` — that is, when `pithy provision --env <name>` has run for it. One that is not is **skipped and reported**, never fatal: standing staging up and proving it before production resources exist is the ordinary bring-up, and this command used to refuse it part way through, naming production, after the bucket and staging's worker already existed. The decision is made once, from one read, before anything is created. A declared environment with no stanza at all is a different thing and stays a refusal — that is config drift, and `pithy provision --env <name>` does not write a stanza.

The bucket is created on the first run **however many environments skip**; it is one per project and must not wait for production. If **every** environment is skipped the run exits 3 (`core/precondition_failed`, with a `fix`) rather than reporting a success, and the refusal names the bucket when this run created it.

`deprovision` removes **one named environment's** classification worker and its `<project>-<env>-support-classify` and `<project>-<env>-support-reprocess` Workflows, the Workflows before the worker, because deleting a Worker leaves the Workflows registered against it. There is no default environment and no "all": it used to walk every declared environment, so a run meant for staging took production's worker with it. Named nothing, or something undeclared, it refuses before any credential is read and lists what could be named. `--env dev` is pointed at `pithy dev` instead.

The environment's own routing rule goes first, so mail stops before its handler does: each rule that sends one of the addresses its composition claims to its app Worker, on the zone holding the address's domain. A rule for the address that sends it anywhere else is left, and so is every other environment's. The project-global rule the provision flags created goes only with `--routing-zone`. The bucket stays unless `--storage` is passed, and with it the key pair is resolved **before** the worker comes down: discovering it missing at the bucket step would leave the worker gone and the bucket standing.

**The project-global rule and the bucket go with the last environment.** Each is one per project: the bucket holds every environment's support history, and that rule delivers the project's inbound mail. A staging teardown with either flag would take production's. It refuses while any other declared environment still runs a classification worker, before anything is deleted. Tear those down first.

```
The support bucket and the inbound routing rule are shared by every environment, and prod still runs. Nothing was deleted.
Deprovision prod first, or drop --storage and --routing-zone.
```

"Still runs" means a deployed classification worker. An app Worker whose stanza still binds the bucket after its environment's classification worker is gone is not asked about. `--storage` is the only confirmation the bucket gets: R2 objects are not counted the way retained D1 rows are.

**The command holds these limits, not the installed package.** The teardown runs from the project's own `@pithy-sh/support`, and a copy from before this check removed the routing rule first and refused after. So the shared check runs before that copy is called, and the copy is handed a deprovisioner that deletes only what the flags asked for, in the named environment. A copy that reaches past that is refused at the reach:

```
@pithy-sh/support asked for deleteWorker("prod") while tearing down staging. Refused.
Update @pithy-sh/support to match this CLI, then run it again.
```

What that copy already deleted in the named environment stays deleted.

Both subcommands audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy support provision`

| key | type | meaning |
|---|---|---|
| `command` | `"support provision"` | The subcommand that produced this line |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `bucket` | object | The R2 bucket, and what happened to it |
| `bucket.bucket` | string | The bucket name — `<project>-global-support`. Reported even when the step was skipped, so the name is always readable |
| `bucket.created` | boolean | True only when this run created it. False when it already existed, and false when skipped |
| `bucket.skipped` | boolean | True when attachments are off and raw retention is off, so no bucket was wanted |
| `environments` | array of `"staging" \| "prod"` | The environments a classification worker was deployed for |
| `skippedEnvironments` | `object[]` | One entry per environment nothing was provisioned for |
| `skippedEnvironments[].env` | `string` | The environment that was skipped |
| `skippedEnvironments[].reason` | `string` | Why — `env.<name> has no DB database_id.` |
| `skippedEnvironments[].action` | `string` | The command that resolves it |
| `search` | array | What the full-text index did, per environment |
| `search[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `search[].created` | boolean | The index was created and backfilled in this run |
| `search[].dropped` | boolean | The index was dropped in this run. Both false means it already matched the config |
| `search[].repaired` | boolean | Its triggers were missing and were restored, and the gap backfilled |
| `semantic` | array | What the semantic message index did, per environment. Absent from a `@pithy-sh/support` that predates it |
| `semantic[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `semantic[].indexName` | string | The environment's index, `<project>-<env>-support-messages` |
| `semantic[].created` | boolean | The index was created in this run |
| `semantic[].dropped` | boolean | The index was dropped in this run, because `search.semantic` is off |
| `semantic[].backfilled` | boolean | This run started the index's one backfill: for an index it created, or one that holds no stamp while inbound mail exists |
| `routing` | object | The inbound Email Routing rules, in sum. `inboundRoutes` has each one |
| `routing.created` | boolean | True when this run created or updated a rule |
| `routing.skipped` | boolean | True when there was nothing to route: every environment claims no address |
| `inboundRoutes` | `object[]` | Each inbound rule this run settled: one per address per provisioned environment, or the one the three routing flags name |
| `inboundRoutes[].env` | string \| null | The environment the rule routes, or `null` for the project-global rule the flags name |
| `inboundRoutes[].address` | string \| null | The exact address the rule matches. `null` when the environment's composition claims none |
| `inboundRoutes[].zone` | string \| null | The zone the rule lives on, by name: the zone holding the address's domain, the parent zone for a subdomain. `null` when no zone the token can list holds it |
| `inboundRoutes[].zoneId` | string \| null | That zone's id. `null` when no zone holds the address's domain |
| `inboundRoutes[].worker` | string \| null | The app Worker the rule sends the mail to, as `pithy deploy` names it for the environment. `null` when it could not be resolved |
| `inboundRoutes[].outcome` | `"created" \| "updated" \| "unchanged" \| "skipped" \| "refused"` | `created`: this run made the rule. `updated`: the sole enabled rule for the address sent it elsewhere, and now sends it to the Worker. `unchanged`: a rule already did. `skipped`: the environment claims no address. `refused`: no rule was made |
| `inboundRoutes[].reason` | string \| null | Why the route was skipped or refused, naming the domain. `null` otherwise |
| `exitCode` | integer | The status the run exits with: `0`. A run that provisions nothing writes no report |

**One outcome, never two.** A run that went ahead writes this report alone and exits 0, whether or not some environments were skipped — `exitCode` says so, and it matches `$?`. A run in which **every** environment was skipped provisioned no environment, so it writes nothing on stdout: the `{"error":…}` line on stderr is the whole answer, exit 3, with the provisioning command as its `fix`, and its message names the bucket when this run created it. `support provision` is not one of the commands whose report is the answer to a failure (`docs/CLI.md` §3.8).

```
$ pithy support provision --worker api --json
{"command":"support provision","schemaVersion":1,"bucket":{"bucket":"acme-global-support","created":true,"skipped":false},"environments":["staging"],"routing":{"created":true,"skipped":false},"search":[{"env":"staging","created":true,"dropped":false,"repaired":false}],"inboundRoutes":[{"env":"staging","address":"staging@help.example.com","zone":"example.com","zoneId":"0a1b2c3d","worker":"acme-staging-api","outcome":"created","reason":null}],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix."}],"exitCode":0}
$ echo $?
0
```

```
$ pithy support provision --worker api --json
{"error":{"code":"core/precondition_failed","status":412,"message":"No environment is ready — staging and prod have no DB database_id. It created the project's support bucket (acme-global-support), which every environment shares.","action":"Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy support provision --json --worker api` again.","exit":3,"retryable":false,"fix":"pithy provision --env staging --yes"}}
$ echo $?
3
```

The second line is on stderr, and stdout is empty.

`pithy support deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"support deprovision"` | The subcommand that produced this line |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `env` | string | The one environment torn down — the value of `--env` |
| `storageDeleted` | boolean | Whether `--storage` was passed, and therefore whether the bucket and everything in it was deleted |
| `routingZone` | string \| null | The zone id the project-global rule was removed from, or `null` when `--routing-zone` was not passed and that rule was left in place |
| `inboundRoutes` | `object[]` | This environment's own inbound rules: one per address its composition claims |
| `inboundRoutes[].env` | string | The environment torn down |
| `inboundRoutes[].address` | string \| null | The address the rule matched. `null` when the composition claims none |
| `inboundRoutes[].zone` | string \| null | The zone the rule lived on, by name. `null` when no zone holds the domain |
| `inboundRoutes[].worker` | string \| null | The app Worker the rule sent mail to. `null` when it could not be resolved |
| `inboundRoutes[].outcome` | `"removed" \| "absent" \| "skipped"` | `removed`: this run deleted the environment's rule for the address. `absent`: no rule sent it to the Worker. `skipped`: nothing could be looked up |
| `inboundRoutes[].reason` | string \| null | Why the removal was skipped. `null` otherwise |

A failing run writes `{"error":{…}}` to stderr instead and exits by its kind (`docs/CLI.md` §3.8) — the same public payload the HTTP surface encodes, with `detail` stripped, plus `exit`, `retryable` and, where the cause is known, `fix`.

## Search

The inbox is searched at `GET {basePath}/threads/search`, behind `support:threads:read`. **Search is its own route, not a filter on the list**: a query goes in, ranked threads come out, up to a limit, with no cursor. The inbox list, `GET {basePath}/threads`, no longer takes `q`, and refuses it as `validation/invalid_input` rather than ignoring it.

| Query | Default | Meaning |
|---|---|---|
| `q` | — | What to search for, up to 200 characters |
| `mode` | every backend that is on | `keyword`, `semantic` or `hybrid`. `semantic` or `hybrid` with `search.semantic` off is a 400 naming the flag |
| `limit` | `20` | Threads to return, at most `50` |
| `archived`, `category`, `declaredCategory`, `priority`, `sentiment`, `channel`, `inbox`, `assignee` | — | The inbox list's filters, applied in D1 after retrieval |

**Keyword** finds the exact words: FTS5, on by default, ranked by `bm25`; the `LIKE` scan with `search.fts` off or the index not yet provisioned, which has no score and ranks by recency. **Semantic** finds the meaning: the query is embedded with the index's pinned model and Vectorize returns the 100 nearest message ids, with no payload. **Hybrid**, the default, runs both and fuses them by reciprocal rank fusion over rank position, so a thread both found rises above one only one found. A tie goes to the keyword hit, then to `lastMessageAt`, newest first — which is what keeps an order number first: semantic search cannot retrieve it, so its thread is keyword's first while semantic's first is some other thread, and the two tie.

A thread is scored by its best-matching message and appears once. Each result names that message, `messageId`, and carries its raw `bm25` and `similarity`, each absent when its backend did not run or did not match it — never normalized into one number. `backends.ran` names what answered, and `backends.skipped` names what was on and could not: FTS5 configured and not provisioned falls back to the `LIKE` scan, and a message index not yet bound, or a model that does not answer, is skipped. A skip degrades the search; it never fails it. Filters run after retrieval, so a narrow one can return fewer than the limit, and `count` is the true number.

**Semantic search costs a second inference per inbound message**, on your Workers AI binding, on top of classification — roughly double the capability's per-message AI cost, and the volume guard bounds messages, not spend. That is why `search.semantic` is off until you turn it on. The embedding runs in the classification Workflow, after the message is stored and, with `ai.enabled` on, classified. With `search.semantic` on and `ai.enabled` off, the Workflow still starts for each inbound message as it arrives, so an inbox that does not classify is still searchable by meaning. Auto-submitted mail starts no Workflow on arrival, so it is neither classified nor embedded then. The flag is read from the message's headers and is not stored, so provision's one-time backfill and every `pithy vector reprocess --index support-messages` embed every inbound message, auto-submitted mail included. An embedding that fails on arrival is not fatal: the message stays out of semantic results until `pithy vector reprocess --index support-messages` picks it up. Vectors carry message ids and nothing else; the text stays in D1.

## Errors

Each is a `PithyError`: the problem, then the action.

**Incomplete routing flags.**

```
The inbound routing options are incomplete.
Pass --routing-zone, --inbound-address, and --app-worker together, or none of them.
```

**The Worker does not compose `support`.** The target, `--worker` or the project's only Worker, has no `support(...)` registration. The config is read off the Worker the run writes into and never off a sibling: the classification hosts are deployed against that Worker's app database, where its tables live.

```
<worker> does not compose the support capability.
Add `support({ ... })` to <worker>'s pithy.config.ts (run `pithy add support --worker <worker> --with-prerequisites`), or name the Worker that composes it with --worker.
```

Named with `--worker`, it is a usage error, exit 2: another `--worker` is the fix. The project's only Worker, unnamed, is `core/precondition_failed`, exit 3, with that same command as its `fix`, `<worker>` being the Worker's `apps/` directory. `--with-prerequisites` is there because support declares `secrets` and that Worker does not compose it yet; a Worker that already does is named without it. The command is built from support's manifest — the installed one, or the kit's own when none is installed — so the line and the `fix` cannot disagree.

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/support` missing answers `The support capability is not installed.` with `pithy add support --worker <w> --with-prerequisites` — read from the kit's own manifest, since none is installed — and, in a project with several Workers, one such command for each Worker; a project with no Worker is told to create one with `pithy worker add` first; the package present with a dependency of its own not installed answers `The support capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The support capability is installed and will not load.`, and so does one whose import names something no install provides: a `#` import its own imports map lacks, or a `node:` module this runtime does not have. A path an installed package does not have, or does not export, answers `The support capability is installed but incomplete.` No install fixes any of those, so the action never offers one, and it names the package that wrote the import.

**Credentials are missing.**

```
Cloudflare credentials are missing.
Export CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this project's account, then run this again.
```

**The project has no name.** The bucket is found by name and reused, so a guessed name would adopt another project's inbox. It is `core/precondition_failed`, exit 3: the call is right and the project is missing what it depends on.

```
pithy.config.ts has no `name`.
```

**No environment is ready.** Every declared environment was skipped, so no environment was provisioned: exit 3, `core/precondition_failed`. The action names the provision every skipped environment needs. Its `fix` is `pithy provision --env <env> --yes` when exactly one of them is an environment an agent may provision; a production one is a person's decision. The bucket is the one thing the run may have made — it is created however many environments skip — and when this run created it, the refusal says so, by name, so the one outcome is the whole account of the run. A bucket an earlier run made is reused and not mentioned.

```
No environment is ready — staging and prod have no DB database_id. It created the project's support bucket (acme-global-support), which every environment shares.
Run pithy provision --env staging --yes to create its app database. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix. Once their app databases exist, run `pithy support provision --worker api` again.
```

**The app Worker declares an environment it has no stanza for.** Config drift rather than provisioning state, so it is refused rather than skipped.

```
api's wrangler.jsonc has no env.prod stanza.
Add the prod environment to apps/api/wrangler.jsonc with its DB binding.
```

**Half an R2 key pair with `--storage`**, or none at all — `The R2 access-key pair is incomplete.` and `No R2 S3 credentials were supplied.`, both refused before a worker comes down.

**Several Workers and no `--worker`.** The resolution error `pithy add` raises, naming the Workers it found.

## Examples

Provision staging, with Email Routing enabled for `help.example.com`:

```
$ pithy support provision
Bucket acme-global-support ready.
  staging  classification worker deployed, search index created, message index created and backfilling
  prod     skipped — env.prod has no DB database_id. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.
staging: staging@help.example.com now routes to acme-staging-api, on example.com.
Done.
```

Run it again and nothing changes:

```
$ pithy support provision
Bucket acme-global-support ready.
  staging  classification worker deployed
  prod     skipped — env.prod has no DB database_id. `pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.
Search index already matches your config.
staging: staging@help.example.com already routes to acme-staging-api, on example.com.
Done.
```

A domain Email Routing is not enabled for is refused, and everything else still provisions:

```
prod: No routing rule. Email Routing is not enabled for help.example.com. Turn it on for the subdomain in the Cloudflare dashboard under example.com > Email > Email Routing > Settings > Subdomains, and the next run routes it.
```

The override, machine-readable:

```
$ pithy support provision --routing-zone 0a1b2c3d --inbound-address support@help.example.com --app-worker acme-prod-api --json
{"command":"support provision","schemaVersion":1,"bucket":{"bucket":"acme-global-support","created":false,"skipped":false},"environments":["staging","prod"],"routing":{"created":true,"skipped":false},"search":[{"env":"staging","created":false,"dropped":false,"repaired":false},{"env":"prod","created":false,"dropped":false,"repaired":false}],"inboundRoutes":[{"env":null,"address":"support@help.example.com","zone":"example.com","zoneId":"0a1b2c3d","worker":"acme-prod-api","outcome":"created","reason":null}],"skippedEnvironments":[],"exitCode":0}
```

Take staging's worker and its rule down, and keep the history:

```
$ pithy support deprovision --env staging
staging: classification worker removed.
staging: staging@help.example.com no longer routes to acme-staging-api.
Done.
```

Take the lot down, the override's rule included, once production is the last environment standing:

```
$ pithy support deprovision --env prod --routing-zone 0a1b2c3d --storage --json
{"command":"support deprovision","schemaVersion":1,"env":"prod","storageDeleted":true,"routingZone":"0a1b2c3d","inboundRoutes":[{"env":"prod","address":"support@help.example.com","zone":"example.com","worker":"acme-prod-api","outcome":"removed","reason":null}]}
```
