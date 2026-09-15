# pithy migrate

_The site renders this for readers: [pithy.sh/docs/cli/commands/migrate](https://pithy.sh/docs/cli/commands/migrate). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Run every Worker's migration registry against one environment's D1, or step every database back one migration.

## Synopsis

```bash
pithy migrate [--env <env>] [--worker <name>] [--binding <binding>] [--rollback]
              [--confirm-rollback <phrase>] [--destroy-retained <n>] [--json]
```

The shipping model these commands sit in — environments, credentials, the ownership stamp, migrate-then-deploy — is [pithy.sh/docs/build/operations/deploy](https://pithy.sh/docs/build/operations/deploy). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. Default `dev`. |
| `--worker <name>` | Migrate one Worker instead of every Worker under `apps/`. |
| `--binding <binding>` | Migrate only the database behind this D1 binding. Combines with `--worker`. A binding nothing in scope declares is refused by name. |
| `--rollback` | Step **every** database in scope back one migration instead of running forward. Narrow it with `--worker` and `--binding`. Default `false`. |
| `--confirm-rollback <phrase>` | Unlock a non-`dev` rollback non-interactively: the exact phrase `yes, i really want to roll back <env>`. |
| `--destroy-retained <n>` | **DESTRUCTIVE.** Let a rollback drop rows in retained tables. Must equal the row count the refusal printed. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

The registry, the ordering, and the per-database runs are identical everywhere; only the driver differs. `dev` runs locally through Miniflare against `<projectRoot>/.wrangler/state` — the same store `wrangler dev` reads — while `staging`, `prod`, and any custom environment execute over the D1 REST API against the remote database the target env's `wrangler.jsonc` stanza names. You pass no ids.

**It fans out over Workers, and a shared database migrates once.** Each Worker contributes its own capabilities' migrations. Workers whose bindings resolve to the same physical D1 are grouped, their sets merged into one ordered provider, and that provider runs a single time — then each result is credited back to the Worker whose capability declared it, so the report never claims a migration a Worker does not own. `--worker` narrows what is *reported* and which databases are visited; it never narrows the registry a visited database runs, because a shared D1's ledger holds both Workers' migrations and a partial provider reads as corrupted state.

**It composes each Worker for the environment it migrates.** A `pithy.config.ts` is code, and `compositionEnvironment()` answers `staging` while `pithy migrate --env staging` evaluates it — exactly as it will inside the deployed Worker. So a config whose migrations differ by environment is migrated with the target environment's set, and `pithy upgrade --env` and `pithy deploy --env`'s pending count count that same set.

**Every run is idempotent.** A second run with nothing pending is a no-op and prints `Nothing to migrate.`

**It says what it is on, while it is on it.** On a remote environment every statement is a D1 round trip, so a run against a fresh database takes minutes, and it used to print nothing until it had finished. An operator watching nothing happen cannot tell a slow schema change from a hung one, and the instinct is Ctrl-C in the middle of it. So each step is named as it starts, one plain line each: the check every database gets before the first write, `▸ Checking DB, SECRETS...`; each database and the Workers it serves, `▸ DB (app) for api, collab...`; and each migration, `▸ Applying 0300_auth_0001_init to DB...` or, on a rollback, `▸ Rolling back 0300_auth_0001_init on DB...`. The last `▸` line of an interrupted run names what was in flight. The per-Worker report below still prints once, at the end, unchanged. A missing TTY gets the same lines, because a run in CI is the run whose log most needs them. `--json` prints none of them.

**The database has an owner.** Every database in the run is claimed for this project — a row beside the migration ledger — *before any of them is written to*, and a database another project owns aborts the whole run rather than being discovered halfway through. An unstamped database is adopted on first migrate; your own is a no-op. This is why `migrate` needs `name` in the root `pithy.config.ts` and refuses to guess one: a guessed name would stamp one value and check a different one next run, locking a project out of its own database.

**The ledger has to match the declaration, in both directions.** Before anything is written, every database in the run is read back: a migration this project declares and the database has not applied is what the run applies, and a migration the database has applied that **nothing declares any more** is refused by name. That second state is what deleting a migration file leaves behind, and Kysely treats it as a corrupted chain — so nothing can migrate until the two agree. No migration is broken there, so the remedy is not "fix the migration": on `dev` it is to delete `.wrangler/state` and run again, and on a deployed environment it is to restore the migration or remove its `pithy_migrations` row, because that database has real rows in it. `pithy doctor` reports the same state before you reach for `migrate`.

### Rolling back

**A rollback steps back one migration in every database in scope, not one migration overall.** Each database has its own ledger, so `--rollback` reverses the latest migration in `DB`, the latest in `SECRETS`, and the latest in every other database the environment binds. Name the one you mean with `--binding`.

**Retained tables refuse.** Some tables hold rows that exist nowhere else — the secrets vault (`pithy_secrets_system_secrets`, `pithy_secrets_rotations`) and the email suppression list (`pithy_email_suppressions`). Their capability declares them retained. Before anything moves, a rollback counts every retained table in scope, and if one holds rows it refuses, naming each table and the total:

```
$ pithy migrate --rollback
Retained 5 rows would be dropped: pithy_secrets_system_secrets on SECRETS (5 rows). Refused before any down against them ran.
They exist nowhere else. Back them up, or pass --destroy-retained 5 to drop them.
```

The refusal is database-wide. Any `down` against a database holding retained rows is refused, even one that never touches them, because a `down` cannot be inspected without running it. `--destroy-retained` takes the number, not a yes: it must equal the count, so a flag typed for another run does not agree to this one. The same refusal stands under the migration runner itself, so `seed --redo` and `remove --drop` meet it too.

**A database other environments bind is kept.** `EMAIL_SUPPRESSIONS` is one database, bound by every environment's stanza. A `--env staging` rollback reversing it would reverse production's suppression list. So a rollback leaves any database whose `database_id` another environment's stanza also names untouched, and says so — `EMAIL_SUPPRESSIONS kept. prod binds it too.` Named with `--binding`, it is refused instead.

**Outside `dev`, a rollback is asked for in words.** The phrase names its environment, so one typed for `staging` cannot be pasted into a command aimed at `prod`. Interactively the prompt asks; in CI pass `--confirm-rollback`.

**After a rollback fails partway, do not roll back again.** The databases that already moved stay moved, and a second rollback steps each of them back another migration. Fix the `down`, then `pithy doctor` shows where each database stands.

**Migrate never seeds and never deploys.** It moves schema. Data fixtures are `pithy seed`; shipping code is `pithy deploy`, which warns when the target environment's schema is behind but never migrates for you.

Credentials for a remote run are `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, from `<config>/cloudflare.json` locally — or straight from the environment in CI, which has no config file. A `dev` run needs neither.

## `--json`

One line on stdout, whose `workers` array groups the run exactly as the human output does. A failure is one `{"error": …}` line on stderr and a non-zero exit.

| key | type | meaning |
|---|---|---|
| `command` | string | `"migrate"`. |
| `project` | string | The project this run was claimed as — `name` from the root `pithy.config.ts`. |
| `env` | string | The environment migrated. |
| `rollback` | boolean | Whether the run stepped back rather than forward. Mirrors `--rollback`. |
| `workers` | object[] | One entry per Worker in the fan-out, in report order. A Worker with no migrations still appears. |
| `workers[].worker` | string | The Worker's name. |
| `workers[].databases` | object[] | The databases that Worker's registry touched, in registry order. Empty when it composes no migrations. |
| `workers[].databases[].database` | string | The database name — a capability's `databases` key. |
| `workers[].databases[].binding` | string | The D1 binding it resolves to in that Worker's `wrangler.jsonc`. |
| `workers[].databases[].results` | object[] | What the migrator did, credited to this Worker. Empty when nothing moved. |
| `…results[].migrationName` | string | The composed migration name, carrying its capability namespace. |
| `…results[].direction` | string | `"Up"` or `"Down"`. |
| `…results[].status` | string | `"Success"`, `"Error"`, or `"NotExecuted"` — the last meaning an earlier migration failed first. |
| `workers[].databases[].sharedWith` | string[], optional | The other Workers bound to this same physical D1. Present **only** when the database is shared. |
| `workers[].databases[].boundBy` | string[], optional | The other environments whose stanzas bind this same database. Present **only** on a rollback that kept it for that reason; its `results` is empty. |

### A run that died partway

A fan-out has no transaction across databases: the third one throws and the first two are already ahead of
it. So the failure line still goes to stderr and the exit is still non-zero, and stdout carries **what the
run changed on the way** — the record you need most when a migration dies mid-fan-out.

```
$ pithy migrate --env staging --json
{"command":"migrate","project":"acme","env":"staging","rollback":false,"workers":[{"worker":"api","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"0100_auth_0001_init","direction":"Up","status":"Success"}]}]}],"failed":{"binding":"COLLAB_DB","database":"collab"},"unreached":[{"binding":"MEDIA_DB","database":"media"}],"interrupted":true}
```

| key | type | meaning |
|---|---|---|
| `interrupted` | boolean | Present and `true` on this line alone. **It is what says `workers` is a truncated report**, not a whole one |
| `workers` | object[] | Here, only the databases whose pass completed before the failure. Same shape as above |
| `failed` | object | The database the run died on, as its `binding` and `database`. Its schema is in whatever state the failed pass left it. No reason: what a migration throws is on the `{"error": …}` line |
| `unreached` | object[] | Every database in scope the run never opened, in fan-out order. Empty means the failure was on the last one — never "nothing was scanned" |

## Errors

- **`No pithy.config.ts here.`** Run it from a Pithy project.
- **`A migration run needs a project name.`** Set `name` in the root `pithy.config.ts`. The stamp is what refuses another project's database instead of silently merging two schemas.
- **A database another project owns.** The refusal names both projects, and nothing in the run has been written. Nothing clears a stamp: handing a database to another project deliberately means dropping that table by hand.
- **`<worker>: wrangler.jsonc has no env.<env> stanza.`** Add the environment and its D1 bindings. A Worker *outside* the run's scope with no stanza for that environment is skipped instead, because it has never migrated there.
- **`wrangler.jsonc env.<env> has no database_id for the "<binding>" binding.`** A remote run needs a real id; there is no local fallback to migrate the wrong store against.
- **`Cloudflare credentials are missing.`** Remote runs only.
- **Two databases on one binding, within a Worker.** A wiring mistake — they would migrate against a single physical store. Give each its own binding.
- **Two Workers migrating one binding under one namespace with different migrations.** Two capabilities wearing one name; their composed keys would collide in the ledger. Rename one, or bind the Workers to different databases.
- **`<binding> records <migration>. This project no longer declares it.`** The ledger holds a migration this project has since dropped, so the migrator refuses the whole chain. The action line says which remedy applies to *this* database: wipe the local dev store, or reconcile the row on a database with real rows in it.
- **A migration itself failing.** The refusal names the migration, the binding it was running against, and what the runtime actually said. The chain is applied one migration at a time, so `detail` also carries the migrations applied before it, which stay applied. The failed migration is not among them: each migration's statements go to D1 as one `batch`, which is one transaction, so a migration that fails partway applies none of itself and records nothing. Nothing is ever batched across a migration boundary — a partial chain has to stay representable in the ledger.
- **`Retained <n> rows would be dropped: …`** A rollback reached a database whose retained tables hold rows. Nothing moved. Back them up, or pass `--destroy-retained <n>` with the printed number. A different number is refused, and says so.
- **`<binding> is bound by <envs> too.`** A rollback named a database another environment binds. It is never reversed from one environment.
- **`Rolling back <env> steps back every database it binds.`** A non-`dev` rollback without its phrase. Pass `--confirm-rollback "yes, i really want to roll back <env>"`.
- **`No database in scope is bound to "<binding>".`** The action lists the bindings this run does have.
- **`--env` is validated at the flag.** `production` is answered with `prod` before any config loads or any database opens.

## Examples

```bash
# Local, the default.
pithy migrate

# Promote the schema.
pithy migrate --env staging --json
pithy migrate --env prod --json

# Step one database back, and only that one.
pithy migrate --env staging --rollback --binding DB --confirm-rollback "yes, i really want to roll back staging"

# One Worker only.
pithy migrate --env prod --worker api --json
```

```json
{"command":"migrate","project":"acme","env":"prod","rollback":false,"workers":[{"worker":"acme-api","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"auth_0001_init","direction":"Up","status":"Success"}],"sharedWith":["acme-collab"]}]},{"worker":"acme-collab","databases":[{"database":"app","binding":"DB","results":[],"sharedWith":["acme-api"]}]}]}
```

Nothing in this payload is a credential.
