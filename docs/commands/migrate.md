# pithy migrate

Run every Worker's migration registry against one environment's D1, or step the latest migration back.

## Synopsis

```bash
pithy migrate [--env <env>] [--worker <name>] [--rollback] [--json]
```

The shipping model these commands sit in — environments, credentials, the ownership stamp, migrate-then-deploy — is [`DEPLOY.md`](../DEPLOY.md). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. Default `dev`. |
| `--worker <name>` | Migrate one Worker instead of every Worker under `apps/`. |
| `--rollback` | Step the latest applied migration back instead of running forward. Default `false`. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

The registry, the ordering, and the per-database runs are identical everywhere; only the driver differs. `dev` runs locally through Miniflare against `<projectRoot>/.wrangler/state` — the same store `wrangler dev` reads — while `staging`, `prod`, and any custom environment execute over the D1 REST API against the remote database the target env's `wrangler.jsonc` stanza names. You pass no ids.

**It fans out over Workers, and a shared database migrates once.** Each Worker contributes its own capabilities' migrations. Workers whose bindings resolve to the same physical D1 are grouped, their sets merged into one ordered provider, and that provider runs a single time — then each result is credited back to the Worker whose capability declared it, so the report never claims a migration a Worker does not own. `--worker` narrows what is *reported* and which databases are visited; it never narrows the registry a visited database runs, because a shared D1's ledger holds both Workers' migrations and a partial provider reads as corrupted state.

**Every run is idempotent.** A second run with nothing pending is a no-op and prints `Nothing to migrate.`

**The database has an owner.** Every database in the run is claimed for this project — a row beside the migration ledger — *before any of them is written to*, and a database another project owns aborts the whole run rather than being discovered halfway through. An unstamped database is adopted on first migrate; your own is a no-op. This is why `migrate` needs `name` in the root `pithy.config.ts` and refuses to guess one: a guessed name would stamp one value and check a different one next run, locking a project out of its own database.

**The ledger has to match the declaration, in both directions.** Before anything is written, every database in the run is read back: a migration this project declares and the database has not applied is what the run applies, and a migration the database has applied that **nothing declares any more** is refused by name. That second state is what deleting a migration file leaves behind, and Kysely treats it as a corrupted chain — so nothing can migrate until the two agree. No migration is broken there, so the remedy is not "fix the migration": on `dev` it is to delete `.wrangler/state` and run again, and on a deployed environment it is to restore the migration or remove its `pithy_migrations` row, because that database has real rows in it. `pithy doctor` reports the same state before you reach for `migrate`.

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
- **A migration itself failing.** The refusal names the migration, the binding it was running against, and what the runtime actually said. D1 applies migrations non-transactionally, so `detail` also carries what was applied before it.
- **`--env` is validated at the flag.** `production` is answered with `prod` before any config loads or any database opens.

## Examples

```bash
# Local, the default.
pithy migrate

# Promote the schema.
pithy migrate --env staging --json
pithy migrate --env prod --json

# Step the latest migration back.
pithy migrate --env staging --rollback

# One Worker only.
pithy migrate --env prod --worker api --json
```

```json
{"command":"migrate","project":"acme","env":"prod","rollback":false,"workers":[{"worker":"acme-api","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"auth_0001_init","direction":"Up","status":"Success"}],"sharedWith":["acme-collab"]}]},{"worker":"acme-collab","databases":[{"database":"app","binding":"DB","results":[],"sharedWith":["acme-api"]}]}]}
```

Nothing in this payload is a credential.
