# pithy upgrade

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

Per Worker, a plan reports four things.

**Missing bindings**, per environment. A required binding the manifest declares that a wrangler stanza lacks — checked for every stanza in the file, since `env.staging` can be behind while the top-level one is current. Applying writes them in, comment-preserving, and appends any Durable Object class migrations.

**Missing config keys.** A manifest config option not yet present in that capability's registration call. Applying inserts it with the manifest's default rendered as its value and the option's rationale as the comment above it. An existing key is never rewritten.

**Ejected capabilities.** Named, never touched. A fork no longer tracks its package, so reconciling it would overwrite code you own.

**Pending migrations**, counted for `--env`. Reported by default; applied only with `--migrate`.

Two things sit outside that list. `entitlementGap` names this Worker's own source files that gate a route on an entitlement while nothing the Worker composes provides one — report-only, because which capability to compose is your decision, not the CLI's. And `missingVersionMetadata` covers the `version_metadata` binding named `CF_VERSION_METADATA`: without it a Worker cannot report which build is running, so log records carry no `version`, audit events carry no build id, and `pithy deploy` cannot verify the deploy it just made. An upgrade adds it. A config naming a *different* binding is reported and left alone.

**Installed is not composed.** The manifests are installed once at the project root and shared by every Worker, so they describe every capability installed anywhere in the project — not what this Worker is made of. A plan is scoped to the Worker's own composed set. A capability another Worker added contributes nothing here; anything else would put a foreign capability's bindings, and its Durable Object class migrations, on a script that never declared them.

**A malformed manifest is named, not skipped in silence.** Faults are project-wide — one install, one `node_modules` — so they are reported once, above the Workers. A capability with a fault appears in no other line of the report: its manifest could not be read, so it contributes no drift and the run reconciles around the hole.

A dry run resolves no project name and proposes none, so nothing can be written. An apply resolves the name from the root `pithy.config.ts`, because a capability wired by `upgrade` must get the same `<project>-<env>-<binding>` resource name it would have got from `add`. With `--migrate`, the name is required and checked first, so a nameless project fails having written nothing rather than mid-fan-out.

`upgrade` skips ejected capabilities, touches no Cloudflare account, and writes only config files and — with `--migrate` — the database for `--env`.

## `--json`

One line, one object. The `workers` array carries a **plan** on a dry run and an **applied** result otherwise, and the two shapes differ.

```
$ pithy upgrade --dry-run --json
{"command":"upgrade","env":"dev","dryRun":true,"workers":[{"worker":"board","deployedAs":"replay-board","env":"dev","perCapability":[{"name":"audit","missingBindings":[],"missingConfigKeys":[]},{"name":"auth","missingBindings":[],"missingConfigKeys":[]},{"name":"secrets","missingBindings":[],"missingConfigKeys":[]}],"ejectedSkipped":[],"ledger":{"state":"read","pending":1,"undeclared":[]},"entitlementGap":[],"missingVersionMetadata":false}],"manifestFaults":[]}
```

```
$ pithy upgrade --json
{"command":"upgrade","env":"dev","dryRun":false,"workers":[{"worker":"board","deployedAs":"replay-board","perCapability":[],"ejectedSkipped":[],"migrated":false,"migrations":[],"addedVersionMetadata":false}],"manifestFaults":[]}
```

### The envelope

| key | type | meaning |
|---|---|---|
| `command` | `"upgrade"` | The command that produced the line |
| `env` | string | The environment the run targeted — the validated `--env` |
| `dryRun` | boolean | Whether `--dry-run` was passed. **This is what says which shape `workers` carries** |
| `workers` | array | One entry per Worker in scope, in discovery order. A plan when `dryRun` is true, an applied result otherwise |
| `manifestFaults` | array | Installed packages shipping a `pithy.manifest.json` that is present and unusable. Project-wide, not per Worker. Empty on a healthy install |
| `manifestFaults[].package` | string | The package the manifest was read from, as an adopter names it: `@pithy-sh/audit` |
| `manifestFaults[].reason` | string | Why it could not be used — the schema's refusal text, or the errno where the file would not open |

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
| `ejectedSkipped` | string[] | Ejected capabilities, by name. Never reconciled — ejected code no longer tracks its package |
| `ledger` | object | What `env`'s databases have applied against what this Worker declares. **The counts sit behind `state`**, so a sum taken over some of the databases cannot be read as a sum over all of them |
| `ledger.state` | `"read"` \| `"partial"` \| `"unavailable"` | Whether every database in scope answered, some did, or none did |
| `ledger.pending` | integer | Unapplied migrations for `env` across this Worker's databases. Applied only with `--migrate`. Present on `read` alone |
| `ledger.undeclared` | array | Migrations `env`'s databases have applied that this Worker no longer declares — the direction a pending count is blind to. Report-only. Present on `read` alone |
| `ledger.counted` | object | The same two fields, over the databases that answered. Present on `partial` alone, and spelled differently there on purpose: it is a sum with a known hole in it |
| `ledger.unreadable` | array | Every database whose ledger could not be read, each with its `database` and `binding`. Present and non-empty on `partial` alone. It carries no reason — what a D1 read throws names an id or a query |
| `entitlementGap` | string[] | This Worker's own source files that gate a route on an entitlement while nothing it composes provides one. Empty means no gap. Report-only |
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

**A Worker config that will not load.** A `pithy.config.ts` that cannot be imported fails the whole run, naming the file and the import that did not resolve.

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
