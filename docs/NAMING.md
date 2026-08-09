# Resource naming

Every Cloudflare resource Pithy provisions is named by one rule.

```
<project>-<env>-<thing>
```

Kebab-case, project first, environment second. No namespace is exempt.

## Why there is a rule at all

Every Cloudflare namespace Pithy writes into is flat and account-wide: D1 databases, KV namespaces, R2 buckets, Vectorize indexes, Worker scripts, Workflows, the Secrets Store, the API-token list. None of them can be partitioned. So the name is the partition, and the project segment is the only thing keeping two Pithy projects in one account from adopting or overwriting each other's resources.

Provisioning finds a resource by name and reuses it. Without a project segment, "find then create" means a second project silently inherits the first's database.

## The namespaces

| Namespace | Name | Example |
|---|---|---|
| D1 (`database_name`) | `<project>-<env>-<binding>` | `acme-prod-db` |
| KV (namespace title) | `<project>-<env>-<binding>` | `acme-prod-sessions` |
| R2 (`bucket_name`) | `<project>-<env>-<capability>` | `acme-prod-storage` |
| Vectorize (`index_name`) | `<project>-<env>-vector-<index>` | `acme-prod-vector-docs` |
| Worker script | `<project>-<env>-<capability>` | `acme-prod-email` |
| Workflow | `<project>-<env>-<capability>-<job>` | `acme-prod-email-send` |
| Secrets Store entry | `<project>-<env>-<secret>` | `acme-prod-secrets-encryption-keys` |
| CF API token | `<project>-<env>-<profile>` | `acme-prod-ci-system` |
| Email Routing rule | `<project>-global-<capability>-<purpose>` | `acme-global-email-bounce` |
| Turnstile widget | `<project>-prod-turnstile-<mode>` | `acme-prod-turnstile-visible` |

The `<thing>` segment is the **binding name** for a resource `pithy add` and `pithy upgrade` propose into your `wrangler.jsonc`, and the **capability** (plus a discriminator where it owns more than one) for a resource a capability's own `provision` command creates. Both compose through the same rule.

Three things are deliberately **not** on this list, because they are not Cloudflare resource names.

**Worker binding names** (`DB`, `SESSIONS`, `MEDIA_BUCKET`) never carry the project. A binding is a variable name inside your own Worker, and two projects cannot collide on it. Renaming one is a breaking change to your code for no benefit.

**Secret registry keys** (`defineSecretRegistry({ … })`) never carry the project either. For a `cf-secrets-store` secret the registry key *is* the Worker binding name and the `.dev.vars` variable name; only the store entry it resolves to is scoped.

**Table names** stay `pithy_<capability>_<table>`. They live inside one database, which is already project-scoped by the database's own name.

## Two stores a name cannot reach

Cloudflare Images and Cloudflare Stream are the exception, and they need a different mechanism.

An asset in either store is keyed by an id Cloudflare mints on upload, not by a name you choose. There is nothing to put a project segment into. So ownership is carried in **metadata** instead: every asset Pithy creates is stamped `pithyProject` and `pithyEnv`, the same two keys in both stores, so one query answers "what does this project own" across them.

The stamp is applied where the asset is created — direct-upload mints and `pithy seed` alike — and it is merged last, so a caller's own metadata bag cannot displace it. A Worker reads its own project from the `PROJECT` var, stamped beside `ENVIRONMENT` in every generated `wrangler.jsonc` and in every prebuilt capability host. A Worker that cannot name its project refuses to mint rather than writing an asset nobody can attribute.

This is weaker than a name, and deliberately so: nothing stops two projects' assets sitting side by side in one account, because ids are unique and neither can adopt or overwrite the other's. What the stamp buys is attribution — knowing which app owns an asset, and being able to sweep one app's assets without touching another's.

## Why project first

The project is the ownership boundary, and every operation that has to answer "is this mine?" keys on the leading segment.

Teardown **recomputes** a name rather than scanning for it, so the project segment is what makes the recomputed name land on the resource that exists. `pithy token list` filters the account's token list on `<project>-<env>-`, so a project only ever enumerates its own credentials. The integration-test reaper deletes nothing whose name does not begin with its reserved prefix.

A hashed or truncated project segment would break all three, which is why the project is never truncated — see [every limit, per namespace](#every-limit-per-namespace).

## Why environment second

These names land in listings nobody can filter — `wrangler d1 list`, the account dashboard, the Secrets Store, the token list. All any of them offer is sort order.

Sorting by name should group a project's resources, and then that project's environments, so everything belonging to production sits together in one block. Putting the environment last scatters production through the listing, interleaved with staging and dev. That is exactly the moment someone acts on the wrong one.

## The three environments

`dev`, `staging`, `prod`. Local, test users, paid users.

**It is `prod`, not `production`.** The environment sits in the middle of every name a project composes, and it is never truncated — so every character of environment costs a character of project name, one for one. `production` is six characters longer than `prod`. That is six characters off the project-name cap for every adopter, spent on a word that says nothing `prod` does not.

**An environment stops at 7 characters** — the length of `staging`, the longest of the three. This is not a preference, it is a derivation input. Every project-name budget on this page is computed against a 7-character environment, so a longer one would retroactively shrink a cap that projects have already been accepted under, and a provisioned project cannot be renamed. `--env` is validated at the flag, before any config is loaded or any Cloudflare call is made.

An environment is lowercase, digits, and single inner hyphens, starting with a letter. It is read **verbatim, never kebab-cased** — unlike the project name. A project name is prose typed once into a config file, so `Acme Corp` is politely composed into `acme-corp`. An environment is an identifier repeated in `--env`, in `.dev.vars.<environment>`, and in a wrangler environment key; normalising `Prod` into `prod` would make one environment answer to two spellings in some places and to one in others.

A custom environment is allowed, and held to the same two rules. `live` is fine. `eu-prod` is fine. `preprod-eu` is 10 characters and is refused. `global` is refused for a different reason: it occupies the same slot for a different purpose, and a project cannot have one set of names covering two scopes.

**A project declares which of them it has.** `environments` in the root `pithy.config.ts`, defaulting to `["staging", "prod"]`, asked at `pithy init` with that default. It is the one answer to "what environments does this project have", and everything that iterates environments reads it: each Worker's `env.<name>` stanzas are generated from it, `pithy secrets provision` gives every declared environment a master key and a manager, and `--env` refuses one the project does not declare, naming the ones it does. `dev` is never listed — it is local, it is the top-level wrangler stanza rather than an `env.dev`, and it always exists.

The list is **ordered, least-production first**. That is the order provisioning walks, so a mistake is made in staging before it is made in prod, and the last entry is the one a `global` account-level secret is written through.

**And it is as permanent as the project name, for the same reason.** `<project>-<env>-<thing>` is recomputed on every command and stored nowhere, so changing an environment name does not rename a database — it orphans it. `pithy doctor` reports a declaration that changed after resources were provisioned under the old names, and stops there: only the adopter can say whether to restore the name or delete what it created.

## `global` in the environment slot

Some things are shared across all of a project's environments on purpose. They put the literal `global` in the environment slot rather than omitting it, so the scheme has no exception to remember.

- `<project>-global-email-suppressions` — the suppression list. "Do not email this person again" is not an environment-local fact; an address that hard-bounced in production must not be retried from staging, or the sending domain's reputation pays for the distinction.
- `<project>-global-secrets-manager` and `<project>-global-secrets-manager-cf-api-token` — the secrets manager's own credential, one per project.
- `<project>-global-support` — the bucket the support inbox's attachments and raw messages live in. A thread does not belong to an environment; the environments are separated by which bucket an operator binds.
- `<project>-global-email-bounce`, `<project>-global-support-inbound` — the Email Routing rules. There is one rule per zone; environments are separated by which Worker it points at, not by the rule.

`global` is a scope decision, not a shortcut. Anything not on a list like this one is per-environment.

## Feature environments

An ephemeral feature environment is an environment, so it occupies the environment slot:

```
<project>-f<issue>-<slug>-<binding>-<kind>
```

`pithy feature create` computes these, `provision` creates them, and `destroy` recomputes the identical strings to delete them. Nothing is stored, which is why every segment has to be derivable from `(project, issue, slug, binding, kind)` alone.

There is **no Worker segment**. Two Workers that both declare `DB` are backed by one D1; a Worker that wants its own declares a different binding. Sharing is expressed in the binding name.

A feature also deploys Workers, under `<project>-f<issue>-<slug>-<worker>`. This is the tightest shape Pithy composes, and it has its own budget — see [the feature-branch budget](#the-feature-branch-budget).

## Where `<project>` comes from

The `name` field in the **root** `pithy.config.ts`. Nothing else.

It is resolved by `requireProjectName`, which throws when it is missing. It is never guessed. The guessing resolver exists for display purposes and falls back to the alphabetically-first Worker and then the directory basename — good enough to print, catastrophic to provision under, because teardown would later compute names matching nothing, delete nothing, and exit 0.

The value is kebab-cased before it is used, so `Acme Backend` and `acme-backend` are the same project.

**A project name starts with a letter and holds only lowercase letters, digits, and single hyphens** — the shape a Cloudflare Worker script name requires, checked against the kebab-cased form. `Acme Corp` is fine. `2026-launch` is not, and neither is a directory named `2026-launch` that `pithy init` would otherwise take its default from.

**It also stops at 26 characters.** Charset and length are one rule with one home, because they fail the same way; the number is derived in [the project-name cap](#the-project-name-cap).

The rule is enforced where the name is minted and again every time it is read, so a name that cannot become a Worker script name is refused before anything is provisioned rather than at the first host deploy — which would leave the project half-built under names it can never finish using.

## It is effectively immutable

Once anything is provisioned, the project name is a contract.

Change it and every subsequent command computes names that do not exist. Provisioning quietly builds a parallel set beside the running one. Teardown finds nothing and reports success. The original D1, KV, buckets, and Worker scripts keep running and keep billing, and nothing in the toolchain refers to them any more.

Two guards exist, and neither of them is an undo.

`pithy doctor` reports a `Project name:` line. It compares the configured name against the resource names this project's own `apps/*/wrangler.jsonc` declare — and it never treats a name's *shape* as evidence. `<app>-<env>-<resource>` is the ordinary Cloudflare convention, so a database you named that way years before you found Pithy looks exactly like one Pithy would have made. Reporting it as an orphan, on the adoption path, and suggesting you delete it, is not a diagnostic. Two things establish a fault, and nothing else does:

- **Drift** — the wiring contradicts the config *wholesale*: every name it declares leads with one and the same other project, and the configured name appears nowhere. The project name is one string, so a rename moves every derived name at once; that signature is checkable from your files alone. It says the two sources of truth in your repo disagree, not that anything is orphaned. Fix it by renaming the project to match the resources, or the resources to match the project.
- **Orphaned** — proven, by Pithy's own `pithy_migrations_owner` stamp on the database: `pithy migrate` recorded a *different* project on a database your wiring still binds. Pithy made it, under that name. The remedy is to rename the project back or move the data onto resources this project owns. Doctor never tells you to delete anything — it can prove one database's provenance, not a list's.

Both fail the exit code, so CI gates on them. A lone foreign name, a mix of names, or two unrelated foreign projects do not: none of those is something a rename can produce, and none of them is proven.

Its evidence is your wiring plus that stamp, never a scan of the account — deliberately, because a resource carrying a *neighbouring* project's segment is the neighbour, not an orphan. The costs: it sees only what `wrangler.jsonc` names (D1 databases and R2 buckets), so an orphaned KV namespace (wrangler records no title), Worker script, Secrets Store entry, or API token is invisible to it; and the stamp covers only databases Pithy has migrated, which is why the wholesale check remains beside it.

`pithy migrate` stamps the project into a `pithy_migrations_owner` row beside the migration ledger, and refuses to write to a database another project owns. Every database in the run is claimed before any of them is written to, so a foreign database aborts the run rather than being found halfway through. Nothing clears the stamp; handing a database to another project means dropping that table by hand.

The stamp is not `migrate`'s alone. Every command that writes to a database claims it the same way — `pithy add`, `pithy remove --drop`, `pithy upgrade --migrate`, `pithy seed --redo`, and the `pithy feature` steps — because they all run through one claim, and that claim refuses a run with no project name. Which is also why those commands need `name` set: a database nobody stamped is a database any project can later adopt.

If you must rename, treat it as a migration you perform: move the data, delete the old resources, then change the name.

## Every limit, per namespace

Cloudflare's limits differ by namespace, and they differ a lot. Pithy holds each one separately.

| Namespace | Cap | Cloudflare's rule | Room for `<thing>` at a 12-character project in `staging` | Too long | Whose cap |
|---|---|---|---|---|---|
| Workflow | 64 | 64 characters. `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` | 43 — though a `<capability>-<job>` stops at 22 for a separate reason, below | Refused | Cloudflare |
| Worker script | 63 | 255 in general, **63 once workers.dev is on**. Alphanumeric and dashes, no leading or trailing dash | 42 | Refused | Cloudflare |
| R2 bucket | 63 | 3 to 63 characters. Lowercase, digits, hyphens; must start **and** end alphanumeric | 42 | Truncated | Cloudflare |
| Vectorize index | 64 | 64 bytes. `^([a-z]+[a-z0-9_-]*[a-z0-9]+)$` — must start with a letter | 43 | Refused | Cloudflare |
| KV namespace title | 512 | 512 characters, and no pattern at all. Spaces and mixed case are accepted | 491 | Truncated | Cloudflare |
| D1 database | 128 | **No documented length cap.** Charset only: `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` | 107 | Truncated | Pithy |
| Secrets Store entry | 128 | **No documented length cap.** "Cannot contain spaces"; wrangler enforces `[A-z0-9-_]+` | 107 | Truncated | Pithy |
| Cloudflare API token | 128 | **No documented cap.** A free-text label | 107 | Truncated | Pithy |

Sources, all verified 2026-07-31: the [Workflows limits page](https://developers.cloudflare.com/workflows/reference/limits/), Cloudflare's OpenAPI schema (`maxLength: 64`) and wrangler's `MAX_WORKFLOW_NAME_LENGTH`; [workers.dev subdomains](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/); [creating R2 buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/); [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/); the OpenAPI schema's `workers-kv_namespace_title.maxLength` and `d1_database-name.pattern`; [managing Secrets Store secrets](https://developers.cloudflare.com/secrets-store/manage-secrets/).

**Read the last column.** Three of these caps are ours, not Cloudflare's. D1 database names, Secrets Store entry names, and API token labels have no published length limit, and no published limit is not the same as no limit — a name is read by humans in listings that cannot be filtered, echoed in CLI output, and pasted into wrangler configs, so it needs an end. Pithy stops them at **128 characters**: twice the longest cap Cloudflare does publish, and roughly twice the longest name Pithy can compose today. If Cloudflare ever documents a real number for one of these, that number replaces ours.

Pithy used to hold **63** against all eight, justified as "R2's cap". That is true of R2 and of nothing else. It cut a KV title at an eighth of its allowance, and it truncated D1 databases, secret entries, and token labels against limits that do not exist. On a 30-character project — legal then, when the cap was looser — the master key's entry came out as `secrets-encryp-91c2e9`, hashed for nothing.

### Refused, or truncated

Which one a namespace gets is not a style choice. It follows from whether the name is a durable address.

**Refused** where renaming orphans something. A Workflow name is the address of every instance running under it. A Worker script name is the address of the deployment and of every `service` binding pointing at it. A Vectorize index name is the address of vectors that cannot be re-embedded for free. In all three, a build error naming the limit is strictly better than a silent rename.

**Truncated** where Pithy recomputes the name from the same inputs on every command — D1, KV, R2, secret entries, tokens. Truncation is deterministic and hash-disambiguated, so `provision` and `destroy` still agree on the string, and a long binding name does not fail a CI run.

**Only `<thing>` is ever shortened.** When it does not fit, it becomes a truncated head plus a short stable hash — `media-bucket` at a budget of 8 becomes `m-f4aeb8`. The hash is derived from the segment alone, so two commands computing the same name agree without storing it anywhere.

**`<project>` and `<env>` are always verbatim.** A hashed project segment would let two long project names share a prefix, and `pithy token list` filters the account's tokens on exactly that prefix — a collision there means one project enumerating and revoking another's credentials. If the project and environment alone overflow a budget, the name is refused with the limit named, never quietly hashed into something ambiguous.

## The project-name cap

**A project name stops at 26 characters.** Lowercase letters, digits, and single inner hyphens, starting with a letter, checked against the kebab-cased form.

The number is derived, not chosen, and it comes from the smaller of two shapes. A project name is the head of every name the project will ever compose, so it has to survive the worst of them.

The first shape is a Workflow, the longest per-environment name.

```
   64   a Workflow name
 -  1   the hyphen before the environment
 -  7   the longest environment, `staging`
 -  1   the hyphen before the tail
 - 22   the longest <capability>-<job>, `media-audio-transcribe`
 ----
 = 33
```

The second is a feature resource, the tightest shape of all.

```
   63   an R2 bucket name
 -  2   `-f`
 -  6   the issue number, at 6 digits — `f999999`
 - 13   `-` plus a slug still legible at 12 characters
 - 13   `-` plus a binding kept whole at 12 characters
 -  3   `-` plus the kind, `d1` | `kv` | `r2`
 ----
 = 26
```

The cap is the minimum: **26**. The feature shape is the binding one, and it used to be invisible — the cap was derived from the Workflow alone, so a project comfortably inside 33 could still compose a feature bucket whose slug had been hashed down to nothing.

The 22-character `<capability>-<job>` in the first derivation is the longest any Pithy capability declares today (`media-audio-transcribe`). A capability that would exceed it fails at its own name rather than shortening every existing adopter's project name, which is a change that cannot be made after the fact.

**Why the cap lives on the project name rather than on each composed name.** Without it, the refusal lands at the first `pithy <capability> provision` — by which point `pithy add` has created real buckets and databases under a name that happened to fit *their* budget. The project is half-provisioned, and the only remedy is a rename, which orphans everything already made. Capped here, `pithy init` refuses it before anything is written.

Practically: aim for 8 to 16 characters. That leaves a comfortable slug on every feature branch and never comes near a Workflow limit.

## The feature-branch budget

This is the tightest shape Pithy composes, so it is worth the arithmetic.

```
<project>-f<issue>-<slug>-<binding>-<kind>
```

Held to R2's 63 — the strictest of the three kinds a feature provisions — so one shape is legal for the bucket, the database, and the KV namespace alike. Five literal characters (`-`, `f`, and three more hyphens) plus a two-character kind is 7, which leaves 56 to divide.

```
project + issue + slug + binding = 56
```

The issue number is reserved **6 digits** — `f999999`, just under a million open issues in one repository, which nothing this toolkit serves is going to exhaust. Every digit reserved here costs one character of every project name, so it is six rather than seven. At the worst case the slug gets `50 - project - binding`.

Here is what that leaves the slug, in characters kept verbatim, at a 6-digit issue.

| Project name | `DB` (2) | `SESSIONS` (8) | `MEDIA_BUCKET` (12) | `EMAIL_SUPPRESSIONS` (18) |
|---|---|---|---|---|
| 4 | 44 | 38 | 34 | 28 |
| 8 | 40 | 34 | 30 | 24 |
| 12 | 36 | 30 | 26 | 20 |
| 16 | 32 | 26 | 22 | 16 |
| 20 | 28 | 22 | 18 | 12 |
| 26 | 22 | 16 | 12 | 6 |

Read the last row against the derivation above: at the maximum project name, a 12-character binding leaves exactly 12 characters of slug. That is where the cap comes from.

A real issue number is rarely six digits, and every digit you do not use comes straight back to the slug. Issue 95 on a 12-character project with a `DB` binding gets 40 slug characters, not 36.

```
acme-f95-project-scope-resources-db-r2
acme-backend-platform-f999999-proj-c37741-email-suppressions-r2
```

A slug over budget is not an error. It becomes a truncated head plus a six-hex hash, which is what the second example shows: `project-scope-resources` had 11 characters to work with, so it became `proj-c37741`. The name is still unique and still recomputable, but nobody reading a bucket listing can tell you which branch owns it.

**The guidance that falls out of it.** Keep the branch slug to roughly 20 characters — `feature/95-project-scope` rather than `feature/95-project-scope-resources-and-limits`. Only the part after the issue number becomes the slug. If a branch needs a long name for humans, it can have one; the cost is a hashed segment in a resource that lives for the length of the review.

A feature's **Worker scripts** share the head and drop the kind: `<project>-f<issue>-<slug>-<worker>`, held to the Worker script rule of 63. The worker name is truncated too if it is what is eating the budget, so a Worker directory called `collaboration-realtime-gateway` deploys rather than failing.

## The `pithy-int-` reservation

`pithy-int-` is reserved for Pithy's own live integration tests, on any account.

Everything a live test creates begins with it. The test-debris reaper deletes nothing that does not. `pithy init` refuses a project name that would land inside the reservation, so the two sets can never overlap — which is what makes automatic reaping safe in both directions.

It is deliberately narrower than the product's own `pithy` prefix. A project may legitimately be called `pithy-app`, and its resources are real. `pithy-int-…` is debris by definition.

## One project, or two?

**Do these apps share users or data? Then it is one project with more Workers, not two projects.**

Two apps often should share. Two projects never can.

A project carries one migration registry and one upgrade cadence. Two projects therefore carry two of each, and `pithy migrate` in one applies schema the other has never heard of. There is no supported way to point them at the same database — the ownership stamp exists specifically to stop it — and no way to share a session KV, a user table, or a signing key across the boundary.

Within a project, **Workers share a resource by declaring the same binding name.** Two Workers that both declare `DB` are backed by one D1. A Worker that wants its own declares `COLLAB_DB` instead. Sharing is expressed in the binding name, not in topology config, and adding a Worker costs you a directory under `apps/`.

So the split is about data, not about deployment. A marketing site and an API that both authenticate the same users are one project. Two products that happen to belong to the same company, sharing nothing, are two projects — and this naming scheme is what lets them sit in one Cloudflare account without touching each other.

## Inbound email is the one open question

Inbound mail — bounce and complaint handling in `@pithy-sh/email`, the support inbox in `@pithy-sh/support` — arrives through Cloudflare Email Routing, and **enabling Email Routing on a zone takes over that zone's MX.** So it is never enabled on an apex that carries real mail. Every inbound address sits on a subdomain zone (`bounce.example.com`, `help.example.com`), delegated by NS from the parent.

The per-project topology follows from that: **one subdomain zone per project**, with that project's own routing rules (`<project>-global-email-bounce`, `<project>-global-support-inbound`) pointing at that project's own Worker. The alternative — one inbound Worker serving several projects — would need a D1 binding into every one of their databases, which is precisely the cross-project coupling this whole scheme exists to prevent, aimed at the most sensitive capability.

**This topology is unverified.** It rests on an assumption nobody has exercised against a live account: that two sibling subdomain zones under one parent, both with Email Routing enabled, each pointing at a different Worker, operate independently. Issue [#47](https://github.com/pithy-sh/pithy/issues/47) carries that check and is open. If sibling subdomain zones do not work that way, multi-project inbound mail is unsupported and this section needs a carve-out rather than an adopter discovering it.

Single-project inbound is not affected. The open question is only what happens when a second project wants its own inbox in the same account.
