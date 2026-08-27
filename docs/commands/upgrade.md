# pithy upgrade

_The site renders this for readers: [pithy.sh/docs/cli/commands/upgrade](https://pithy.sh/docs/cli/commands/upgrade). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Reconcile every Worker's wiring with the capability manifests the project has installed.

## Synopsis

```
pithy upgrade [--env <env>] [--worker <name>] [--dry-run] [--migrate] [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--env <env>` | string | `dev` | Target environment — drives the pending-migration count, and any `--migrate` run. `dev`, `staging`, `prod`, or a custom name |
| `--worker <name>` | string | — | Upgrade only this Worker. Default: every Worker under `apps/` |
| `--dry-run` | boolean | `false` | Show the plan without writing anything |
| `--migrate` | boolean | `false` | Run pending migrations after reconciling |
| `--json` | boolean | `false` | Machine-readable output |

## What it does

A capability's manifest grows. A new release declares a binding it did not need before, or a config option it now takes. `upgrade` is what closes that gap in an existing project: it compares each Worker's `pithy.config.ts` and `wrangler.jsonc` against the manifests installed under the project's `node_modules/@pithy-sh`, and adds what is missing.

Capabilities are per Worker, so the reconcile engine is too. `upgrade` fans out over `apps/*`, building one plan per Worker against that Worker's own wiring and applying it there. `--worker <name>` narrows the run to one. Output is grouped by Worker: a project with two Workers gets two blocks, and `--json` carries one entry each.

Per Worker, a plan reports five things.

**Missing bindings**, per environment. A required binding the manifest declares that a wrangler stanza lacks — checked for every stanza in the file, since `env.staging` can be behind while the top-level one is current. Applying writes them in, comment-preserving, and appends any Durable Object class migrations.

**Missing config keys.** A manifest config option not yet present in that capability's registration call. Applying inserts it with the manifest's default rendered as its value and the option's rationale as the comment above it. An existing key is never rewritten.

**Ejected capabilities.** Named, never touched. A fork no longer tracks its package, so reconciling it would overwrite code you own.

**Missing Durable Object exports.** A `durable_objects.bindings` entry is half of a Durable Object; the other half is `export { <Class> } from "…";` on the module `main` names, which is what wrangler resolves `class_name` against. A class bound in `wrangler.jsonc` and absent from the entry is drift a config read alone cannot see — the binding is there and the class is nowhere — so it is reported per capability and written by an apply.

**Pending migrations**, counted for `--env`. Reported by default; applied only with `--migrate`.

Two things sit outside that list. `entitlements` names this Worker's own source files that gate a route on an entitlement while nothing the Worker composes provides one — report-only, because which capability to compose is your decision, not the CLI's. And `missingVersionMetadata` covers the `version_metadata` binding named `CF_VERSION_METADATA`: without it a Worker cannot report which build is running, so log records carry no `version`, audit events carry no build id, and `pithy deploy` cannot verify the deploy it just made. An upgrade adds it. A config naming a *different* binding is reported and left alone.

**The entry is the one file `upgrade` writes that is source rather than config**, so both halves of that write are named. A dry run says what is missing and an apply says what it wrote:

```
api:
  Worker entry: export MultiplayerSession.

api:
  Worker entry: exported MultiplayerSession.
```

Over every composed capability, not only the ones with a missing binding — a project wired before the CLI wrote that line has the binding already and the export nowhere, and `wrangler deploy` refuses it with *Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file*. That project is exactly who runs this command, so it is reported rather than repaired in silence, and `pithy doctor` fails on it under `bindings`. A Worker whose config names no `main` has no entry to read and is passed over.

**Installed is not composed.** The manifests are installed once at the project root and shared by every Worker, so they describe every capability installed anywhere in the project — not what this Worker is made of. A plan is scoped to the Worker's own composed set. A capability another Worker added contributes nothing here; anything else would put a foreign capability's bindings, and its Durable Object class migrations, on a script that never declared them.

**A malformed manifest is named, not skipped in silence.** Faults are project-wide — one install, one `node_modules` — so they are reported once, above the Workers. A capability with a fault appears in no other line of the report: its manifest could not be read, so it contributes no drift and the run reconciles around the hole.

A dry run resolves no project name and proposes none, so nothing can be written. An apply resolves the name from the root `pithy.config.ts`, because a capability wired by `upgrade` must get the same `<project>-<env>-<binding>` resource name it would have got from `add`. With `--migrate`, the name is required and checked first, so a nameless project fails having written nothing rather than mid-fan-out.

`upgrade` skips ejected capabilities, touches no Cloudflare account, and writes only config files, the Worker entry's Durable Object exports, and — with `--migrate` — the database for `--env`.

## `--json`

One line, one object. The `workers` array carries a **plan** on a dry run and an **applied** result otherwise, and the two shapes differ. **Every entry leads with `state`**, and only `"reconciled"` carries either of those shapes — a Worker that could not be read has no plan to report, and no empty one to be mistaken for a clean bill.

```
$ pithy upgrade --dry-run --json
{"command":"upgrade","env":"dev","dryRun":true,"workers":[{"state":"reconciled","worker":"board","deployedAs":"replay-board","env":"dev","perCapability":[{"name":"audit","missingBindings":[],"missingConfigKeys":[]},{"name":"auth","missingBindings":[],"missingConfigKeys":[]},{"name":"secrets","missingBindings":[],"missingConfigKeys":[]}],"ejectedSkipped":[],"ledger":{"state":"read","pending":1,"undeclared":[]},"entitlements":{"state":"read","gates":[]},"missingVersionMetadata":false}],"manifestFaults":[]}
```

```
$ pithy upgrade --json
{"command":"upgrade","env":"dev","dryRun":false,"workers":[{"state":"reconciled","worker":"board","deployedAs":"replay-board","perCapability":[],"ejectedSkipped":[],"migrated":false,"migrations":[],"addedVersionMetadata":false}],"manifestFaults":[]}
```

### The envelope

| key | type | meaning |
|---|---|---|
| `command` | `"upgrade"` | The command that produced the line |
| `env` | string | The environment the run targeted — the validated `--env` |
| `dryRun` | boolean | Whether `--dry-run` was passed. **This is what says which shape `workers` carries** |
| `workers` | array | One entry per Worker in scope, in discovery order. A plan when `dryRun` is true, an applied result otherwise |
| `workers[].state` | `"reconciled"` \| `"unplanned"` \| `"unapplied"` \| `"refused"` | Whether this Worker was reconciled, could not be planned at all, was planned and failed partway through the apply, or was refused before the first write. The fields below appear on `reconciled` alone |
| `manifestFaults` | array | Installed packages shipping a `pithy.manifest.json` that is present and unusable. Project-wide, not per Worker. Empty on a healthy install |
| `manifestFaults[].package` | string | The package the manifest was read from, as an adopter names it: `@pithy-sh/audit` |
| `manifestFaults[].reason` | string | Why it could not be used — the schema's refusal text, or the errno where the file would not open |

### `workers[]` when a Worker was refused

A Worker whose `declinedBindings` cannot be honored carries `{"state":"refused","worker":"api","plan":{…},"code":…,"message":…,"status":…,"action":…}`. **Distinct from `unapplied`, and the distinction is the fact you need**: nothing was written, so there is no half-reconciled wiring to inspect — only a declaration to fix. `message` and `action` are the operator's own problem and remedy lines, in the shape every `pithy` error uses; `plan` is what the Worker gives up until the declaration is fixed.

It is refused on `--dry-run` too. A dry run's job is to predict the write, and this is the thing that stops it, so both tenses report it and both exit non-zero.

### `workers[]` when a Worker could not be reconciled

A Worker whose plan could not be built carries `{"state":"unplanned","worker":"api"}` and nothing else. Its
`pithy.config.ts` or its `wrangler.jsonc` would not read, so nothing was established about it and nothing was
written for it — and the fields a reconciled entry has would each be a claim nobody checked. It carries no
reason: what a config load or a database read throws names a path, an id, or a query.

A Worker whose **apply** failed partway carries `{"state":"unapplied","worker":"api","plan":{…}}`. That is a
different state on purpose, and the difference is that this Worker's files have been opened for writing: its
`wrangler.jsonc` may hold part of the plan, and under `--migrate` its schema may have moved. The `plan` is
what the run set out to do, not what landed — what landed is exactly what an interrupted apply cannot say.

Every *other* Worker still reports in full. A run that loses four Workers' reports to a fifth one's broken
config is the report you cannot use on the day you need it. **Either state exits 1**, on the same standard
`pithy doctor` holds: a Worker that was not reconciled establishes nothing, and exiting 0 around it would be
a weaker gate than the failure it replaced.

### `workers[]` when `dryRun` is `true`

| key | type | meaning |
|---|---|---|
| `worker` | string | The Worker this plan targets, as its `apps/<name>` directory — what `--worker` accepts |
| `deployedAs` | string | The same Worker's deployed script name, from `wrangler.jsonc` — what the Cloudflare dashboard shows |
| `env` | string | The environment the pending-migration count was computed for |
| `perCapability` | array | Per installed, non-ejected capability: what an upgrade would add |
| `perCapability[].name` | string | The capability's short name, from its manifest |
| `perCapability[].missingBindings` | array | Required bindings absent from one or more environments' `wrangler.jsonc` stanzas |
| `perCapability[].missingBindings[].env` | string | The environment missing the binding — `dev` for the top-level stanza, else the `env.<name>` key |
| `perCapability[].missingBindings[].name` | string | The Worker env binding name the capability requires, e.g. `DB`, `SESSIONS` |
| `perCapability[].missingBindings[].type` | string | The kind of Cloudflare resource: `d1`, `kv`, `r2`, `ai`, `vectorize`, `queue`, `ratelimit`, `email`, `secret`, `workflow`, `service`, `durable_object` |
| `perCapability[].missingConfigKeys` | array | Manifest config options not yet present in this capability's `pithy.config.ts` registration |
| `perCapability[].missingConfigKeys[].key` | string | The option name to add to the registration call |
| `perCapability[].missingConfigKeys[].default` | JSON value | The manifest default rendered as the option's value — a scalar, or a worked example you replace |
| `perCapability[].missingConfigKeys[].describe` | string | The option's rationale, rendered as the comment above it |
| `perCapability[].missingEntryExports` | string[] | Durable Object classes this capability binds in this Worker that the module its `main` names does not export. wrangler resolves `class_name` against that module and refuses the deploy without it. An apply writes them |
| `ejectedSkipped` | string[] | Ejected capabilities, by name. Never reconciled — ejected code no longer tracks its package |
| `declinedBindings` | object | This Worker's `declinedBindings`, resolved against what it composes. **The entries sit behind `state`**, so a declaration that would not parse cannot be read as declining nothing |
| `declinedBindings.state` | `"read"` \| `"invalid"` | Whether the declaration parsed |
| `declinedBindings.problem` | string | Present when `invalid`: what is wrong, naming the entry |
| `declinedBindings.declines` | array | Present when `read`: one entry per declined binding, sorted by name |
| `declinedBindings.declines[].state` | `"honored"` \| `"required"` \| `"undeclinable"` \| `"unrecognized"` | Whether the decline is being applied, or refused because the binding is required, refused because its kind cannot be declined (Workflow, Durable Object), or names nothing this Worker composes |
| `declinedBindings.declines[].name` | string | The binding name, as declared |
| `declinedBindings.declines[].type` | string | The kind of Cloudflare resource. Absent on `unrecognized` — nothing declares it, so there is no kind to report |
| `declinedBindings.declines[].capability` | string | The composed capability that declares the binding. Absent on `unrecognized` for the same reason |
| `declinedBindings.declines[].reason` | string | The reason written in `pithy.config.ts` |
| `declinedBindings.declines[].stillPresentIn` | string[] | Present when `honored`: environments whose stanza still carries the binding, written by an upgrade that ran before the decline. Declining stops it coming back; it never deletes what is there |
| `ledger` | object | What `env`'s databases have applied against what this Worker declares. **The counts sit behind `state`**, so a sum taken over some of the databases cannot be read as a sum over all of them |
| `ledger.state` | `"read"` \| `"partial"` \| `"unavailable"` | Whether every database in scope answered, some did, or none did |
| `ledger.pending` | integer | Unapplied migrations for `env` across this Worker's databases. Applied only with `--migrate`. Present on `read` alone |
| `ledger.undeclared` | array | Migrations `env`'s databases have applied that this Worker no longer declares — the direction a pending count is blind to. Report-only. Present on `read` alone |
| `ledger.counted` | object | The same two fields, over the databases that answered. Present on `partial` alone, and spelled differently there on purpose: it is a sum with a known hole in it |
| `ledger.unreadable` | array | Every database whose ledger could not be read, each with its `database` and `binding`. Present and non-empty on `partial` alone. It carries no reason — what a D1 read throws names an id or a query |
| `entitlements` | object | Whether this Worker gates a route on an entitlement while nothing it composes provides one — and whether the scan ran at all. Report-only |
| `entitlements.state` | `"read"` \| `"unavailable"` | Whether the Worker's source tree was scanned |
| `entitlements.gates` | string[] | The gating source files, relative to the Worker's directory. Empty means no gap. Present on `read` alone, so an all-clear and an unread tree cannot be confused |
| `missingVersionMetadata` | boolean | Whether this Worker's `wrangler.jsonc` lacks the `version_metadata` binding named `CF_VERSION_METADATA` |

### `workers[]` when `dryRun` is `false`

| key | type | meaning |
|---|---|---|
| `worker` | string | The Worker this apply targeted, as its `apps/<name>` directory — what `--worker` accepts |
| `deployedAs` | string | The same Worker's deployed script name, from `wrangler.jsonc` — what the Cloudflare dashboard shows |
| `perCapability` | array | Per capability that **changed**. A capability with nothing added does not appear |
| `perCapability[].name` | string | The capability's short name |
| `perCapability[].addedBindings` | array | The bindings written into `wrangler.jsonc` for this capability, same shape as `missingBindings` above |
| `perCapability[].addedBindings[].env` | string | The environment stanza the binding was written into |
| `perCapability[].addedBindings[].name` | string | The binding name that was written |
| `perCapability[].addedBindings[].type` | string | The kind of Cloudflare resource it refers to |
| `perCapability[].addedConfigKeys` | string[] | The config option keys inserted into this capability's registration. Keys only, not the rendered values |
| `ejectedSkipped` | string[] | Ejected capabilities, by name — reported, never touched |
| `migrated` | boolean | Whether the migration step ran. True only when `--migrate` was passed |
| `migrations` | array | The per-database migration runs when `migrated`; empty otherwise |
| `migrations[].database` | string | The database name — a capability's `databases` key |
| `migrations[].binding` | string | The D1 binding it resolves to in this Worker's `wrangler.jsonc` |
| `migrations[].results` | array | The migrations this Worker's capabilities contributed, and how each fared |
| `migrations[].results[].migrationName` | string | The migration's namespaced name |
| `migrations[].results[].direction` | `"Up" \| "Down"` | The direction it was executed in |
| `migrations[].results[].status` | `"Success" \| "Error" \| "NotExecuted"` | `NotExecuted` means an earlier migration failed |
| `migrations[].sharedWith` | string[] | The other Workers bound to this same physical D1. Present only when a database is shared |
| `addedVersionMetadata` | boolean | Whether this run added the `version_metadata` binding the Worker was missing |
| `addedEntryExports` | string[] | The Durable Object classes this run exported from the Worker's entry. Empty when the entry already carried them |

**The two shapes differ in what a run produced, never in how it names the Worker.** `worker` and `deployedAs` are in both, carrying the same two strings, because `workers` is one array and `dryRun` is what says which shape fills it — a key present on one side and absent on the other would mean a consumer that worked under `--dry-run` read `undefined` on the run that actually wrote something. The applied entry used to drop `deployedAs`; it does not now.

## Errors

Each one is a `PithyError`: the problem, then the action. Under `--json` it is a single `{"error":{…}}` line on stderr and exit 1.

**An environment that does not exist.** Validated at the flag, before anything is read.

```
$ pithy upgrade --env production
"production" is not an environment name in Pithy.
Use `prod`.
```

**A `--worker` that names nothing.**

```
$ pithy upgrade --worker nope
No worker named "nope".
Run pithy worker list to see this project's workers. Known: replay-board.
```

**A Worker config that will not load.** A `pithy.config.ts` that cannot be imported fails the whole run, naming the file and the import that did not resolve. That is the Worker *set* failing to resolve — the fan-out's input, not one of its contributors, so there is nothing left to report per Worker. A failure while a Worker is being **planned or applied** is the other thing entirely: it costs that Worker its entry (`state` above) and every other Worker still reports.

```
$ pithy upgrade
Could not load apps/board/pithy.config.ts.
Nothing resolves "@pithy-sh/core/src/capability/capability". Install the project's dependencies (bun install), or correct that import.
```

**`--migrate` on a project with no `name`.** Resolved before any Worker is reconciled, so nothing is written.

## Examples

See what an upgrade would do, and write nothing.

```
$ pithy upgrade --dry-run
board:
  Nothing to upgrade.
Dry run. Nothing written.
```

A project with two Workers reports both. Every Worker in scope appears, including one with nothing to do — the run covered it, and silence would read as "skipped".

```
$ pithy upgrade --dry-run
deck:
  Nothing to upgrade.
tally:
  Nothing to upgrade.
Dry run. Nothing written.
```

Reconcile, then apply what is pending.

```
$ pithy upgrade --migrate --env staging
```

Narrow to one Worker.

```
$ pithy upgrade --worker deck
```
