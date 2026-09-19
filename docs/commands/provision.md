# pithy provision

_The site renders this for readers: [pithy.sh/docs/cli/commands/provision](https://pithy.sh/docs/cli/commands/provision). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Create an environment's own Cloudflare resources, wire them into every Worker, and migrate.

## Synopsis

```
pithy provision --env <environment> [--yes] [--confirm <phrase>] [--seed] [--json]
pithy provision --feature [--json]
```

One job, two spellings. `--env` provisions an environment the root `pithy.config.ts` declares; `--feature` provisions the one this branch gets. **Exactly one of them is required**, and passing both is refused at the flag, before a config is loaded or a Cloudflare client is built.

`--env` runs from the project root. `--feature` runs from inside the feature worktree, and takes no name: the branch says which feature it is.

## Why one command

Both modes create one Cloudflare resource per binding name across every Worker, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in `pithy.config.ts`, or derived from the branch. That is a flag, not a different verb.

The safety is in the scope, not in the spelling. A `ProvisionScope` carries the resource naming **and** the `env.<name>` stanza the ids are written into, as one value — so a feature-named resource landing in a declared environment's stanza of a checked-in config is unexpressible rather than merely refused. Nothing about that depends on which words were typed, which is what leaves the command surface free to be whatever reads best.

## The one real difference: what happens to the ids

| | writes | status |
|---|---|---|
| `--env <name>` | `env.<name>` in the Worker's tracked `wrangler.jsonc` | **source** — long-lived ids a human reviews in a pull request |
| `--feature` | `apps/<worker>/.wrangler/pithy/wrangler.feature.jsonc` | **build artifact** — git-ignored, rebuilt every run, never committed |

A single flag that flips whether output is committed will eventually surprise someone, so **every run states the file it wrote and what happens to it**:

```
Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
```

`--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than inferring it. This is also what keeps the standing rule true: **a CI build process never commits back to the repository.** A pipeline runs `--feature` and has nothing to commit; a human runs `--env` and commits ids in a pull request.

## `--feature` is explicit, never inferred

It is not derived from "the branch looks like a feature branch". An implicit mode switch on branch shape is how someone on `feature/…` provisions the wrong thing while reading a command line that says nothing about it. The flag is the declaration; the branch is only where a feature's *name* comes from once you have made it.

The two modes cannot reach each other's environment either. `--feature` writes the `feature` stanza and nothing else. `--env` accepts only what the project declares, and `feature` can never be declared — it is a legal wrangler stanza key and an illegal declaration, because a feature's config is generated rather than committed, and one stanza cannot have two owners.

## Why it exists at all

A project scaffolded, wired and migrated by pithy could not be deployed, and nothing said why.

```
pithy add <cap>          runs the Worker's dev migrations — local D1 through Miniflare.
                         Creates nothing remote.
pithy migrate --env prod queries the target database. Assumes it exists.
pithy deploy             provisions nothing. Spawns wrangler.
```

So `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way — and the first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in. The provisioner was never missing; only the command and the naming were.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--env <environment>` | — | — | The declared environment to provision. Refused unless the root `pithy.config.ts` lists it |
| `--feature` | — | `false` | Provision this branch's own environment instead. Run from inside the worktree |
| `--yes` | `--env` | `false` | Confirm that this creates real Cloudflare resources. Required for every declared environment |
| `--confirm <phrase>` | `--env` | — | Unlock a production environment non-interactively: `yes, i really want to provision <env>` |
| `--seed` | `--env` | `false` | Also load seed fixtures once the schema is up |
| `--json` | both | `false` | One line of machine-readable output |

`--yes`, `--confirm` and `--seed` say nothing a feature environment does not already do. It is created per pull request and destroyed on merge, so there is nothing to confirm — a gate every pipeline has to pass is a gate that has stopped meaning anything — and it is created empty, so it always seeds.

## What it does

1. **Resolves the scope.** The naming and the stanza come from one object, never two arguments: `<project>-<env>-<thing>` into `env.<env>` for a declared environment, `<project>-f<issue>-<slug>-<thing>` into `env.feature` for a branch's. That is what makes a name whose environment segment disagrees with the stanza it lives in unexpressible rather than merely discouraged.
2. **Provisions one resource per binding name**, across the union of every Worker's capabilities. Two Workers that both declare `DB` share one database; a Worker that wants its own declares a different binding.
3. **Adopts rather than duplicates.** Every resource is matched by name before it is created, so a re-run is a no-op and a database an adopter made by hand under the right name is taken up rather than shadowed by a second one.
4. **Writes the ids into each Worker's config**, under `env.<name>` — and a Worker receives only the bindings its own config declares. The D1 entry gets its `database_name` alongside its `database_id`, because `pithy add` proposes the name offline and this is the step that makes the proposal true. The stanza is created when it is absent, so an environment declared after the project was scaffolded needs no hand-editing.
5. **Writes the `secrets_store_secrets` stanza** for every `cf-secrets-store` secret the Worker's own registry declares, when a Secrets Store id is in hand. `pithy add` deliberately could not write it — the entry needs a `store_id` and a `secret_name` that do not exist until an account has been reached — so a Worker deployed without `SECRETS_ENCRYPTION_KEYS` and failed at its first request. A declared secret whose entry has not been created is reported rather than bound: wrangler refuses a config naming an absent entry, so binding it would turn one missing value into a failed deploy of the whole Worker.
6. **Creates the secrets that have no decision in them.** A registry entry declares whether its value is *arbitrary* — a signing key, an ingest secret: any random string works, because nothing outside the project has to agree with it. Provisioning mints those and binds them in the same pass. It still stops for a *supplied* secret — an OAuth client secret, a payment rail's key — because a random string there authenticates against nothing. Absence is checked first, always: an existing value is never replaced, and replacing one is rotation, which is a separate and deliberate act. No minted value is printed, logged, or put in an audit event; the run reports that the secret was created and which entry it went to. A supplied secret gets the line that names the two commands that finish it — `SESSION_SIGNING_KEY has no store entry yet. Run pithy secrets create SESSION_SIGNING_KEY --env staging to supply its value, then pithy secrets provision to write the stanza.` — and an entry the kit *can* compose a value for, including `SECRETS_ENCRYPTION_KEYS`, gets the other one: `Run pithy secrets provision — it creates the store entries and writes the stanza.` Which of the two you get is one decision, taken in one place, and `pithy doctor` prints the same answer for the same finding.
7. **Retargets `service` bindings** at this environment's copy of the callee, resolved through each Worker's real deploy name rather than its `apps/<name>` directory.
8. **Binds `SELF`, for a project that administers itself.** A Worker cannot fetch its own hostname: the subrequest loops back through the edge into the Worker it came from and hangs until Cloudflare answers 522, on a route that answers in a second and a half from outside. So a project whose root `pithy.config.ts` says `administersItself: true` gets one more `services` entry in every stanza this writes — `SELF`, pointing at the script that stanza deploys as — and the code calls itself with `env.SELF.fetch(request)`, dispatched inside the runtime with no edge hop. The binding name is `@pithy-sh/core`'s `SELF_BINDING`, so nothing has to agree a string by hand. It is written from the same `name` this step writes, so the two cannot disagree; a re-run retargets in place rather than duplicating; and a project that declares nothing gets no entry and no change to its stanza. **A feature environment is why this is the kit's job rather than a line you add yourself**: its stanza is generated on every `pithy provision --feature`, so a hand-written entry never survives to the deploy, and the script it would have to name is composed from the branch. It is deliberately absent from the report's `services` list, which is one flat set for the whole project: the self entry is per Worker, and N lines with no Worker beside them would say less than the `workers` lines above them already do. **The top-level stanza gets none, and that is the rule rather than an omission**: the 522 is an edge behavior, and `wrangler dev` serves a Worker fetching its own address as an ordinary local request, so a dev run needs no binding and a call site that wants one falls back to an ordinary `fetch` there. `pithy doctor` names a declared self-administering project whose declared stanza lacks it, or whose entry names a script that stanza does not deploy as.
9. **Migrates**, and seeds when asked. A feature also records a manifest — the resources it created and the Worker script names it wrote — so `pithy feature destroy` deletes exactly what was created and deployed — the one thing a declared environment has no equivalent of, which is [`feature.md`](feature.md)'s subject.
10. **Stands up every kit Worker a feature composes (#643).** A feature is an environment, and it runs what an environment runs: every host its capabilities own — email's sender, media's enrichment, storage's sweep, payments' reconcile, support's classifier, testers' daily pass, vector's reprocess, and the secrets manager. Each is deployed through the registry entry, resolver and gated deploy `pithy deploy` ships a declared environment's with, handed the feature, so every name it is called or binds is the feature's: `<project>-f<issue>-<slug>-<capability>`, its Workflows named the same way. A host any of whose names is not the feature's fails rather than deploys. The app Worker's `workflows` bindings into the hosts are written **after** the deploy, and only for the hosts that deployed, so a host that failed leaves no binding for the next `pithy deploy --env feature` to ship. Any host that does not deploy fails the run; the next run finishes it. An app Worker whose directory would give it a kit host's name — `apps/email`, `apps/secrets`, any of them — is refused before anything is created.
11. **Shares nothing with any other environment.** The Cloudflare account and its one Secrets Store are the only containers a feature cannot have its own of, and everything inside them is split: its databases, namespaces, buckets and Vectorize indexes, its Workers and Workflows, and every store entry — a `global` secret's included. That holds against every other feature and environment of this project and of every other project in the account: a feature name is `<project>-f<issue>-<slug>--<thing>`, which nothing else composes (see [`NAMING.md`](../NAMING.md)). **Rate limiters are the one exception: features share them with each other, never with staging or production.** Cloudflare keys a limiter's counters by `namespace_id` across the account, so the top level's id would have a branch spend production's per-IP budget. Every `ratelimits` binding in a feature stanza, copied from the top level or declared under a tracked `env.feature`, gets its limiter's fixed feature namespace: the declared `namespace_id` plus 1000000000, so `1001` is `1000001001` in every feature of every project. An offset cannot collide, so distinct limiters keep distinct namespaces, and it lands in a range no environment may declare. A limiter that cannot be offset — no `namespace_id`, one not spelled in decimal digits, or one outside 1 through 999999999 — is refused before anything is created. Nothing account-wide is created for rate limiting.
12. **Answers on its own `workers.dev` address and nothing else.** Its stanza states `routes: []`, so it never inherits the top level's custom domain, and the run says which routes it gave up — inherited or declared under a tracked `env.feature` — rather than dropping them silently.
13. **Refuses a slug that does not fit.** Feature names are never truncated, so a branch whose slug does not fit every name the feature composes is refused before anything is created, naming the longest slug the project takes at that issue. See [`NAMING.md`](../NAMING.md#the-feature-branch-budget).

**The feature range is reserved in every environment, and every project.** `pithy provision --env <any>` refuses a Worker that declares a `namespace_id` from 1000000000 through 1999999999, at the top level or in any stanza, before anything is created, whether or not the project has ever provisioned a feature: every feature of any project in the account binds its limiters in that range, and a declared id there would share counters with a branch. The id is read as the integer it spells, so `"01031275746"` is refused as `1031275746`. `pithy deploy` refuses the same, and `pithy doctor` reports it.

## While it runs

Provisioning creates real resources over a network, one at a time. So it says what it is about to do before it does any of it, then narrates each step as it happens — a run against a slow account and a hung command are not the same thing, and a command that prints nothing until it finishes cannot tell you which one you have (#515).

The plan comes **before the confirmation**, because that is the moment you are being asked to authorize real Cloudflare resources:

```
Provisioning staging for dash.

  databases  dash-global-email-suppressions, dash-staging-db
  buckets    dash-staging-media
  workers    board, email
  secrets    dash-staging-secrets-encryption-keys

▸ dash-global-email-suppressions...
dash-global-email-suppressions: created.
▸ dash-staging-db...
dash-staging-db: exists.
```

Nothing in the plan reaches your account to produce it: the resource set, the Worker set and the store entries are all resolved from your own repository, and they are the run's own inputs rather than a second calculation of them — so a plan that named something the run then skipped would fail this project's tests rather than mislead you.

That pairing is also what makes an interrupted run readable. Provisioning is idempotent and safe to re-run, but idempotence only helps if you know where it stopped: the last `▸` line names the resource that was in flight.

The migrations and seeds that close a run narrate the same way, in `pithy migrate`'s and `pithy seed`'s own words: `▸ DB (app) for board...`, `▸ Applying 0300_auth_0001_init to DB...`.

Plain lines, printed once, never redrawn — so the history survives in your scrollback and in a CI log, and a non-interactive run gets the same bytes without escape codes. Under `--json` none of it is printed: that output is exactly one line, as it is for every command.

## A manifest it could not read

An installed `@pithy-sh/*` package whose `pithy.manifest.json` is present and will not parse is named — above the plan, and again on stderr when the run finishes:

```
Provisioning staging for dash.

  @pithy-sh/email: malformed pithy.manifest.json. Its resource naming and declines went unread.
    requiredBindings[1].scope: not a known scope

  databases  dash-staging-db, dash-staging-email-suppressions
```

It sits above the rows because it is what puts them in doubt. The bindings themselves come from the composed capability, so the resources are still created — but two things that decide **what they are called** and **whether they are wanted** live in that file. A manifest nobody could read declares no `scope`, so a project-global suppression database is created per environment, which is the split [#513](https://github.com/pithy-sh/pithy/issues/513) exists to remove; and it resolves a `declinedBindings` entry as `unrecognized`, so a binding you removed is created and written back. Neither is a refusal — one broken package must not cost you the other fifteen capabilities' provisioning — and both are silent without this line.

It is a defect in somebody's package rather than a fact about your run, so the summary copy goes to stderr and the run's own lines stay on stdout. `--json` carries it as `manifestFaults`. `pithy add --list`, `pithy upgrade` and `pithy doctor` report the same packages.

## What it left out

A binding a Worker names in `declinedBindings` gets no resource created for it, and no entry in that Worker's stanza. See [`docs/CLI.md`](../CLI.md) for the declaration itself.

A decline is the one input to this command that *removes* work, and removed work leaves no trace of itself: the summary lists what was made, so a decline read correctly and a decline dropped on the floor print the same bytes. So the run states what it left out, and why, one line per entry:

```
SUPPORT_BUCKET (r2) declined by board. Not created by this run. — Attachments are off, so nothing would ever be written to it.
ASSETS (r2) declined by board. Created anyway for collab. — no R2 for this Worker.
ASSET declined by board. Nothing it composes declares it, so nothing was left out. — no R2 in this account.
DB (d1) declined by board. auth requires it, so nothing was left out. — we use Postgres.
declinedBindings in board's pithy.config.ts cannot be read, so nothing was left out: `declinedBinding` is not a key this Worker's config declares. Did you mean `declinedBindings`?
```

Your own reason is printed back verbatim — it is required in `declinedBindings` precisely so a report can hand it back, and it carries the one fact the binding name does not.

Every line but the first says **nothing was left out**, and none of them is noise:

- **`Created anyway for <workers>`.** Provisioning is per binding *name*, which is how two Workers share a database. One Worker declining `ASSETS` while a sibling still declares it leaves the resource in place and the declining Worker's stanza without it. A line that called this a skip would send you looking for a resource that exists.
- **A decline that names nothing, or that is refused.** A one-character slip in the binding name is the likeliest typo in a decline, and it resolves against nothing. So does a decline of a binding a capability requires, or of a Workflow or Durable Object. Each is reported and none is fatal.
- **A declaration that cannot be read.** One typo in the block and *every* declined resource is created. Without this line that run is byte-identical to a project that declines nothing.

**`Not created by this run` is the exact claim, and no larger one.** Provisioning adds bindings and never removes them, so declining something an earlier run already provisioned leaves the resource in your account and the binding in the Worker's stanza. Delete both by hand; `pithy doctor` names the environments the binding survives in.

## The secrets it cannot create

A `d1` secret — the auth session secret — is sealed under a master key that lives inside an environment's secrets manager Worker. Only that manager can write one, and this command runs before the managers are necessarily deployed. So it creates none of them, and it says which, rather than reporting `Provisioned prod. Migrated.` for an environment that cannot serve a request.

**Who can create them is not the same answer in both modes.**

`--env` names the command:

```
auth-session-secret: not created here — they need a deployed manager.
Run pithy secrets provision to create them.
```

`--feature` creates them the way `pithy secrets provision` does, when the account has a Secrets Store (#643). A
feature has its own `SECRETS` database, so it gets its own secrets manager: the run creates the feature's own
master key, only if absent, through the provisioner `pithy secrets provision` uses, deploys the feature's manager
with its other kit Workers, and then asks that manager to create every `d1` secret the registry says may be
generated, through the same `mintDeclaredSecrets` pass. **No token.** A feature's manager binds no Cloudflare API
token and rotates nothing, so branch code never holds write access to the account's Secrets Store. Nothing is
pending:

```
auth-session-secret created in feature.
```

**The feature's own stores are the only copy, and the manager is the only writer.** The CLI never holds a
value: the manager probes before anything is minted and writes with `create`, which never replaces a secret
that is there, so a re-run from any machine changes nothing, and a probe that fails fails the run rather than
reading as an absence. **Nothing depends on which run created the key.** The manager seals every row under
whatever key the store holds, so a run that fails anywhere after the key exists — a migration, a host deploy, the
mint itself — is finished by the next one. Two runs at once leave one value: the manager's `create` is a single
insert-if-absent, and the loser is told the secret already exists.

Without a Secrets Store there is no key to give a manager, and the shortfall names the run that would create them:

```
auth-session-secret: not created here — they need a deployed manager.
Run pithy provision --feature with SECRETS_STORE_ID set to create them.
```

A `cf-secrets-store` secret the registry calls arbitrary — the email link-signing key, since #596 — is not on that line in either mode. The account's Secrets Store answers whether the entry exists, so it is created and bound in the same pass (`secretBindings`), in the branch's own scope for a feature.

`pithy secrets provision` spans the environments the project **declares**, deploying a manager into each. A branch is not declared, so that command does nothing for one; `pithy provision --feature` is what gives a branch its manager.

`--json` carries the distinction as `pendingSecretsRemedy` — the command that creates them.

## Production

`--yes` is not enough for production, and never becomes enough. A production environment — the built-in `prod`/`production`, plus anything the project declares in `seed.productionEnvironments` — additionally requires the exact phrase:

```
pithy provision --env prod --yes --confirm "yes, i really want to provision prod"
```

The phrase names its environment, so one typed for `staging` cannot be pasted into a command targeting `prod`. Interactively the CLI asks for it; under `--json` it must arrive by flag, so a headless production provision happens only when a human wrote the phrase into the pipeline.

## Deploy refuses, it does not provision

`pithy deploy --env staging` checks first, and refuses with the command to run when a binding has no resource behind it:

```
staging declares bindings with no Cloudflare resource behind them: board.DB (d1).
Run pithy provision --env staging --yes, then deploy.
```

A deploy that silently created account resources would be hard to review, and these are the resources worth reviewing. `pithy doctor` reports the same state without being asked.

## Teardown

`pithy feature destroy` reverses a branch's environment, because a branch's environment is disposable.

For a declared environment there is none, deliberately. Staging and production are not disposable, and the one-word difference between the two is not a difference a flag should carry. Delete them in Cloudflare, by hand, on purpose.

## `--json`

```
$ pithy provision --env staging --yes --json
{"command":"provision","env":"staging","resources":[{"kind":"d1","binding":"DB","name":"replay-staging-db","id":"9f0…","created":true}],"workers":[{"worker":"replay-board","name":"replay-staging-board"}],"services":[],"secretBindings":[],"declined":[],"manifestFaults":[],"configs":[{"worker":"replay-board","path":"apps/board/wrangler.jsonc","ids":3}],"committed":true,"pendingSecrets":["auth-session-secret"],"pendingSecretsRemedy":"pithy secrets provision"}
```

```
$ pithy provision --feature --json
{"command":"provision","env":"feature","resources":[{"kind":"d1","binding":"DB","name":"replay-f251-one-command--db-d1","id":"3c1…","created":true}],"workers":[{"worker":"replay-board","name":"replay-f251-one-command--board"}],"services":[],"secretBindings":[],"declined":[{"state":"read","worker":"replay-board","declines":[{"state":"honored","name":"SUPPORT_BUCKET","type":"r2","capability":"support","reason":"Attachments are off.","wantedBy":[]}]}],"manifestFaults":[],"configs":[{"worker":"replay-board","path":"apps/board/.wrangler/pithy/wrangler.feature.jsonc","ids":3}],"committed":false,"pendingSecrets":["auth-session-secret"],"pendingSecretsRemedy":"pithy provision --feature with SECRETS_STORE_ID set"}
```

| key | type | meaning |
|---|---|---|
| `command` | `"provision"` | The command that produced the line. The same for both modes |
| `env` | `string` | The environment provisioned — a declared name, or `feature` |
| `resources` | `object[]` | Every resource, in provision order |
| `resources[].kind` | `"d1" \| "kv" \| "r2"` | The Cloudflare resource type |
| `resources[].binding` | `string` | The Worker binding this resource backs, e.g. `DB` |
| `resources[].name` | `string` | The full Cloudflare resource name |
| `resources[].id` | `string` | The Cloudflare-assigned id — a D1 uuid, a KV namespace id, or the bucket name for R2 |
| `resources[].created` | `boolean` | True when this run created it; false when a resource of that name already existed and was adopted |
| `workers` | `object[]` | Each Worker and the script name it deploys under in this environment |
| `workers[].worker` | `string` | The Worker's own deploy name — its `wrangler.jsonc` `name` |
| `workers[].name` | `string` | The scoped script name written into `env.<name>`. A declared environment keeps the name its stanza declares, else `<worker>-<env>`; a feature composes `<project>-f<issue>-<slug>-<app>` from the `apps/<app>` directory, so the project appears once |
| `services` | `object[]` | Each `service` binding and the Worker it now targets in this environment |
| `services[].binding` | `string` | The binding name |
| `services[].service` | `string` | The script the binding was retargeted at |
| `secretBindings` | `object[]` | Every `cf-secrets-store` secret this environment declares |
| `secretBindings[].secret` | `string` | The secret's registry key — the name `pithy secrets create` takes |
| `secretBindings[].binding` | `string` | The Worker binding it is read through: the registry key in SCREAMING_SNAKE_CASE, so `email-link-signing-key` binds as `EMAIL_LINK_SIGNING_KEY` |
| `secretBindings[].entry` | `string` | The Secrets Store entry it resolves to in this environment |
| `secretBindings[].bound` | `boolean` | True when the entry exists and the binding was written. False when the secret is declared and its entry has never been created — binding it anyway would make wrangler refuse the whole config |
| `secretBindings[].minted` | `boolean` | True when **this run** created the value, because the registry declared it may be minted. False on a re-run, which leaves an existing value alone |
| `declined` | `object[]` | One entry per Worker whose `declinedBindings` has something to say. Empty for a project that declines nothing, which is most of them |
| `declined[].state` | `"read" \| "invalid"` | Whether that Worker's declaration parsed. `invalid` means it did not, so **nothing was left out for that Worker** and every declined resource was created |
| `declined[].worker` | `string` | The Worker's own deploy name |
| `declined[].problem` | `string` | `invalid` only: what is wrong with the declaration, naming the entry |
| `declined[].declines` | `object[]` | `read` only: every entry in that Worker's declaration, resolved |
| `declined[].declines[].state` | `"honored" \| "required" \| "undeclinable" \| "unrecognized"` | **Only `honored` left something out.** The other three are reported so a decline that changed nothing is not silent — the likeliest typo in a decline is in the binding name, and it lands on `unrecognized` |
| `declined[].declines[].name` | `string` | The binding name, as you wrote it |
| `declined[].declines[].type` | `"d1" \| "kv" \| "r2" \| …` | The kind of resource it refers to. Absent on `unrecognized`, which names no binding to have a kind |
| `declined[].declines[].capability` | `string` | The composed capability that declares it. Absent on `unrecognized` |
| `declined[].declines[].reason` | `string` | Your own reason, verbatim |
| `declined[].declines[].wantedBy` | `string[]` | `honored` only: other Workers that declare the same binding and did not decline it. **Non-empty means the resource was created anyway** — provisioning is per binding name, and that is how two Workers share a database. Only this Worker's stanza leaves it out |
| `manifestFaults` | array | Installed packages shipping a `pithy.manifest.json` that is present and unusable. Project-wide, not per Worker. Empty on a healthy install |
| `manifestFaults[].package` | string | The package the manifest was read from, as an adopter names it: `@pithy-sh/audit` |
| `manifestFaults[].reason` | string | Why it could not be used — the schema's refusal text, or the errno where the file would not open |
| `configs` | `object[]` | Where the ids were written, one entry per Worker |
| `configs[].worker` | `string` | The Worker's own deploy name |
| `configs[].path` | `string` | The file written, relative to the project root |
| `configs[].ids` | `number` | How many binding ids landed in it |
| `committed` | `boolean` | Whether those files are committed. `true` for `--env`, `false` for `--feature` — the one field a pipeline reads to know it has nothing to commit |
| `pendingSecrets` | `string[]` | The `d1` secrets this run declares and **did not create**. For `--env`, their values are sealed under a master key inside the environment's secrets manager, which this command runs before deploying. For `--feature`, every one the feature's own manager accounted for is left off. Empty when the project declares none |
| `featureSecrets` | `object[]` | `--feature` with a Secrets Store only: each `d1` secret the feature's own manager accounted for, as `pithy secrets provision --json` reports `generated`. Names, never a value |
| `featureSecrets[].name` | `string` | The secret's registry name |
| `featureSecrets[].created` | `string[]` | `["feature"]` when this run created it; empty when it was already there |
| `hosts` | `object[]` | `--feature` only: every kit Worker the feature stood up for itself, one row each, as `pithy deploy --json` reports `kit` |
| `routesDropped` | `object[]` | `--feature` only, and only when there were any: each Worker's route patterns the feature stanza gave up, as `{ worker, routes }` |
| `pendingSecretsRemedy` | `string \| null` | The command that does create them. `"pithy secrets provision"` for `--env`; `"pithy provision --feature with SECRETS_STORE_ID set"` for `--feature`, whose own run creates them once it has a Secrets Store. A pipeline branches on this rather than on the mode |

## Exit codes

`0` on success. Non-zero with a one-line problem and an action for: no mode or both modes, a missing declaration, missing credentials, a branch that is not a feature branch, an unconfirmed production run, or a `service` binding naming a Worker this project does not have — which is refused before a single resource is created.

## See also

- [`feature.md`](feature.md) — the rest of a branch's lifecycle: `create`, `sync`, `destroy`
- [`deploy.md`](deploy.md) — what refuses when this has not been run
- `docs/NAMING.md` — the `<project>-<env>-<thing>` rule and its character budget
