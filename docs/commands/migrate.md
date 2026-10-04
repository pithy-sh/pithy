# pithy migrate

_The site renders this for readers: [pithy.sh/docs/cli/commands/migrate](https://pithy.sh/docs/cli/commands/migrate). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Run every Worker's migration registry against one environment's D1, or reverse the group a previous run applied.

## Synopsis

```bash
pithy migrate [--env <env>] [--worker <name>] [--binding <binding>] [--group <value>]
              [--rollback] [--confirm-rollback <phrase>] [--destroy-retained <n>] [--json]
```

The shipping model these commands sit in — environments, credentials, the ownership stamp, migrate-then-deploy — is [pithy.sh/docs/build/operations/deploy](https://pithy.sh/docs/build/operations/deploy). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. Default `dev`. |
| `--worker <name>` | Migrate one Worker instead of every Worker under `apps/`. |
| `--binding <binding>` | Migrate only the database behind this D1 binding. Combines with `--worker`. A binding nothing in scope declares is refused by name. |
| `--group <value>` | Name the group this run applies under, instead of the ISO-8601 timestamp it would generate. On `--rollback`, the group to reverse — **required**. |
| `--rollback` | Reverse the `--group` named, in every database in scope, instead of running forward. Narrow it with `--worker` and `--binding`. Refuses without a group. Default `false`. |
| `--confirm-rollback <phrase>` | Unlock a non-`dev` rollback non-interactively: the exact phrase `yes, i really want to roll back <env>`. |
| `--destroy-retained <n>` | **DESTRUCTIVE.** Let a rollback drop rows in retained tables. Must equal the row count the refusal printed. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

The registry, the ordering, and the per-database runs are identical everywhere; only the driver differs. `dev` runs locally through Miniflare against `<projectRoot>/.wrangler/state` — the same store `wrangler dev` reads — while `staging`, `prod`, and any custom environment execute over the D1 REST API against the remote database the target env's `wrangler.jsonc` stanza names. You pass no ids.

**It fans out over Workers, and a shared database migrates once.** Each Worker contributes its own capabilities' migrations. Workers whose bindings resolve to the same physical D1 are grouped, their sets merged into one ordered provider, and that provider runs a single time — then each result is credited back to the Worker whose capability declared it, so the report never claims a migration a Worker does not own. `--worker` narrows what is *reported* and which databases are visited; it never narrows the registry a visited database runs, because a shared D1's ledger holds both Workers' migrations and a partial provider reads as corrupted state.

**It composes each Worker for the environment it migrates.** A `pithy.config.ts` is code, and `compositionEnvironment()` answers `staging` while `pithy migrate --env staging` evaluates it — exactly as it will inside the deployed Worker. So a config whose migrations differ by environment is migrated with the target environment's set, and `pithy upgrade --env` and `pithy deploy --env`'s pending count count that same set.

**Every run belongs to a group, and a successful run prints it.** `--group <value>` takes any string the caller holds — a release stamp, a build id — and the run records it against every migration it applies, in every database it touches. One run is one group, however many databases and migrations it spans. A run that names none is stamped with the moment it ran, as an ISO-8601 timestamp: `Group: 2026-10-03T19:52:47.611Z`. A timestamp rather than a date, because one run is one group — date-only would merge two unrelated runs on a busy day, and reversing it would undo more than the caller did. Passing the same value twice **extends** that group, which is how a release whose migrate half-failed is retried; a generated group is per-run and never extends, because nothing connects two unnamed runs.

The group lives in `pithy_migrations_groups`, beside the ledger and the owner stamp rather than in them: `pithy_migrations` is Kysely's own table and its rows carry a name and a timestamp and nothing else. Like the owner stamp, the table is not a migration — a rollback and `seed --redo`'s full reset leave it standing. What a reversal removes is the rows of the migrations it reversed.

**Every run is idempotent.** A second run with nothing pending is a no-op and prints `Nothing to migrate.`

**It says what it is on, while it is on it.** On a remote environment every statement is a D1 round trip, so a run against a fresh database takes minutes, and it used to print nothing until it had finished. An operator watching nothing happen cannot tell a slow schema change from a hung one, and the instinct is Ctrl-C in the middle of it. So each step is named as it starts, one plain line each: the check every database gets before the first write, `▸ Checking DB, SECRETS...`; each database and the Workers it serves, `▸ DB (app) for api, collab...`; and each migration, `▸ Applying 0300_auth_0001_init to DB...` or, on a rollback, `▸ Rolling back 0300_auth_0001_init on DB...`. The last `▸` line of an interrupted run names what was in flight. The per-Worker report below still prints once, at the end, unchanged. A missing TTY gets the same lines, because a run in CI is the run whose log most needs them. `--json` prints none of them.

**The database has an owner.** Every database in the run is claimed for this project — a row beside the migration ledger — *before any of them is written to*, and a database another project owns aborts the whole run rather than being discovered halfway through. An unstamped database is adopted on first migrate; your own is a no-op. This is why `migrate` needs `name` in the root `pithy.config.ts` and refuses to guess one: a guessed name would stamp one value and check a different one next run, locking a project out of its own database.

**The ledger has to match the declaration, in both directions.** Before anything is written, every database in the run is read back: a migration this project declares and the database has not applied is what the run applies, and a migration the database has applied that **nothing declares any more** is refused by name. That second state is what deleting a migration file leaves behind, and Kysely treats it as a corrupted chain — so nothing can migrate until the two agree. No migration is broken there, so the remedy is not "fix the migration": on `dev` it is to delete `.wrangler/state` and run again, and on a deployed environment it is to restore the migration or remove its `pithy_migrations` row, because that database has real rows in it. `pithy doctor` reports the same state before you reach for `migrate`.

### Rolling back

**A rollback names the group it reverses, and `pithy migrate --rollback` on its own reverses nothing.** It refuses, names the group on top, says what reversing it would undo, and prints the command that does it:

```
$ pithy migrate --rollback
Refusing to roll back without a group. The newest group is 2026-10-03T19:52:47.611Z, applied 2026-10-03 19:52 UTC: DB holds 2000_app_0003_release_notes, EMAIL_SUPPRESSIONS holds 0100_email_0002_reasons.
Reverse it with pithy migrate --rollback --group 2026-10-03T19:52:47.611Z.
```

That is the breaking change, and it is the point: a rollback used to step back one migration in *every* database in scope, so what one command reversed depended on what each database happened to apply last, and reversing a deploy that moved three migrations was three invocations with the count coming from outside the tool.

**`--rollback --group <value>` reverses exactly that group** — each database's portion, in reverse chain order, and nothing outside it. A database that holds none of the group is left alone; a release that only touched one database is not a group half-reversed.

**Only the group on top can be reversed.** Kysely steps down from the tip, so reversing a buried group would mean reversing everything over it — migrations from groups nobody named. A request for any other group is refused, naming the group that is actually on top: `Only the group on top can be reversed. DB applied release-7 over release-6.`

**Top means the top of the ledger, not of the group table.** A migration can be applied under no group at all — by a kit older than this, by `seed --redo`'s reset reapplying one that was pending, or by a run whose group write failed — and such a migration buries the groups beneath it just as another group would. The refusal names it and says what it is: `DB applied 1000_app_0002_more (ungrouped) over release-7. Nothing records which run applied 1000_app_0002_more.`

**And a refusal only prints a command when that command works.** A group extended *after* another one ran holds that run's migration inside it, so each of the two is buried under the other and neither is on top. There is nothing to reverse as a group there, and the refusal says so — `Only a group holding the newest migrations can be reversed, and none here does. Run pithy doctor to see where each database stands.` — rather than naming a group whose own refusal would name the first one back.

**When databases hold different newest groups, the refusal names each one** rather than choosing. A `--worker`- or `--binding`-scoped run is how two databases come to disagree, there is no single answer, and inventing one is how the wrong thing gets reversed. Reverse them one at a time, narrowed to their own database.

**A group reverses completely or not at all.** Every refusal condition is checked across every database in the group *before the first `down`* — the retained-table count, a database another environment binds, and a migration in the group that declares no `down`. Reversing as it went would leave a group half-undone the first time the third database refused, which is the exact state groups exist to prevent.

**`--group` composes with the narrowing.** `--rollback --group <v> --binding DB` reverses that group's portion of one database and leaves the rest of the group applied. It is also the way to reverse what *can* come down when the group reaches a database another environment binds.

**Retained tables refuse.** Some tables hold rows that exist nowhere else — the secrets vault (`pithy_secrets_system_secrets`, `pithy_secrets_rotations`) and the email suppression list (`pithy_email_suppressions`). Their capability declares them retained. Before anything moves, a rollback counts every retained table in the databases the group reverses, and if one holds rows it refuses, naming each table and the total:

```
$ pithy migrate --rollback --group 2026.10.3-1
Retained 5 rows would be dropped: pithy_secrets_system_secrets on SECRETS (5 rows). Refused before any down against them ran.
They exist nowhere else. Back them up, or pass --destroy-retained 5 to drop them.
```

The refusal is database-wide. Any `down` against a database holding retained rows is refused, even one that never touches them, because a `down` cannot be inspected without running it. `--destroy-retained` takes the number, not a yes: it must equal the count, so a flag typed for another run does not agree to this one. One budget is spent across the whole group, so an agreement to five rows cannot destroy five in every database. The same refusal stands under the migration runner itself, so `seed --redo` and `remove --drop` meet it too.

**A database other environments bind is never reversed.** `EMAIL_SUPPRESSIONS` is one database, bound by every environment's stanza. A `--env staging` rollback reversing it would reverse production's suppression list. A group that holds part of such a database is refused whole — `EMAIL_SUPPRESSIONS is bound by prod too. A staging rollback of group release-7 does not reverse it.` — because the group cannot come down completely, so none of it comes down. A group that holds none of it leaves it alone and says so: `EMAIL_SUPPRESSIONS kept. prod binds it too.` `seed --redo`'s reset keeps it the same way.

**Outside `dev`, a rollback is asked for in words.** The phrase names its environment, so one typed for `staging` cannot be pasted into a command aimed at `prod`. Interactively the prompt asks; in CI pass `--confirm-rollback`.

**After a rollback fails partway, fix the `down` before anything else.** The databases that already moved stay moved. Each migration's group row is forgotten as it comes down, so re-running the *same* `--group` reverses what is left of it and nothing else — but `pithy doctor` is what shows where each database stands first.

**Migrate never seeds and never deploys.** It moves schema. Data fixtures are `pithy seed`; shipping code is `pithy deploy`, which warns when the target environment's schema is behind but never migrates for you.

Credentials for a remote run are `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, from `<config>/cloudflare.json` locally — or straight from the environment in CI, which has no config file. A `dev` run needs neither.

## `--json`

One line on stdout, whose `workers` array groups the run exactly as the human output does. A failure is one `{"error": …}` line on stderr and a non-zero exit.

| key | type | meaning |
|---|---|---|
| `command` | string | `"migrate"`. |
| `project` | string | The project this run was claimed as — `name` from the root `pithy.config.ts`. |
| `env` | string | The environment migrated. |
| `rollback` | boolean | Whether the run reversed a group rather than running forward. Mirrors `--rollback`. |
| `group` | string | The group this run applied under, or reversed — the `--group` value, or the ISO-8601 timestamp the run generated. Reported in both directions. |
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

A fan-out has no transaction across databases: the third one throws and the first two are already ahead of it. So the failure line still goes to stderr and the exit is still non-zero, and stdout carries **what the run changed on the way** — the record you need most when a migration dies mid-fan-out.

```
$ pithy migrate --env staging --json
{"command":"migrate","project":"acme","env":"staging","rollback":false,"group":"2026-10-03T19:52:47.611Z","workers":[{"worker":"api","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"0100_auth_0001_init","direction":"Up","status":"Success"}]}]}],"failed":{"binding":"COLLAB_DB","database":"collab"},"unreached":[{"binding":"MEDIA_DB","database":"media"}],"interrupted":true}
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
- **`<binding> is bound by <envs> too.`** A rollback named, or a group reached, a database another environment binds. It is never reversed from one environment, and nothing in the group is.
- **`Refusing to roll back without a group.`** `--rollback` with no `--group`. The refusal names the newest group, what it holds in each database, and the command that reverses it. When the databases disagree it names each one's own newest group instead.
- **`Only the group on top can be reversed.`** The group named is buried — under another group, or under a migration applied with no group at all, which the refusal names as `(ungrouped)`. Reverse the group on top first; the refusal names it when there is one, and says there is none when the groups are interleaved.
- **`Group <value> cannot be reversed: <binding>'s <migration> has no down.`** A migration in the group declares none, and Kysely leaves such a migration applied rather than reversing it — so the group cannot come down whole, and the pre-flight refuses it with nothing moved. Give that migration a `down` and reverse the group again. A reset is not a way round it: `migrateDown` skips a missing `down` whatever the target, so `pithy seed --redo` would leave the same migration applied.
- **`No group holds the newest migrations: …`** `--rollback` with no `--group`, against a chain whose tip belongs to no reversible group. Nothing is reversed and no command is printed, because there is none that would work: `pithy doctor` shows where each database stands.
- **`No database in scope records group "<value>".`** A typo, or a group that has already been reversed. The action names the newest group each database does record.
- **`Rolling back <env> reverses a group of migrations in every database it binds.`** A non-`dev` rollback without its phrase. Pass `--confirm-rollback "yes, i really want to roll back <env>"`. The phrase is checked before any database is read, so outside `dev` it is answered before the missing `--group` is.
- **`No database in scope is bound to "<binding>".`** The action lists the bindings this run does have.
- **`--env` is validated at the flag.** `production` is answered with `prod` before any config loads or any database opens.

## Examples

```bash
# Local, the default. Prints the group it applied under.
pithy migrate

# Promote the schema under the release's own stamp, so the rollback command is known in advance.
pithy migrate --env staging --group 2026.10.3-1 --json
pithy migrate --env prod --group 2026.10.3-1 --json

# Reverse that release, every database it touched.
pithy migrate --env prod --rollback --group 2026.10.3-1 --confirm-rollback "yes, i really want to roll back prod"

# Reverse only one database's portion of it.
pithy migrate --env staging --rollback --group 2026.10.3-1 --binding DB --confirm-rollback "yes, i really want to roll back staging"

# One Worker only.
pithy migrate --env prod --worker api --json
```

```json
{"command":"migrate","project":"acme","env":"prod","rollback":false,"group":"2026.10.3-1","workers":[{"worker":"acme-api","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"auth_0001_init","direction":"Up","status":"Success"}],"sharedWith":["acme-collab"]}]},{"worker":"acme-collab","databases":[{"database":"app","binding":"DB","results":[],"sharedWith":["acme-api"]}]}]}
```

Nothing in this payload is a credential.
