# pithy restore

_The site renders this for readers: [pithy.sh/docs/cli/commands/restore](https://pithy.sh/docs/cli/commands/restore). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Restore a `pithy backup` into an empty D1, in the order that makes it whole.

## Synopsis

```bash
pithy restore <dir> [--env <name>] [--worker <name>] [--binding <binding>] [--database <name>] [--group <value>] [--json]
```

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `<dir>` | — | The directory `pithy backup` wrote, or one database's folder inside it |
| `--env <name>` | `dev` | The environment to restore into |
| `--worker <name>` | every Worker | Restore only the databases this Worker binds. Folders of the backup it binds none of are skipped, so one Worker's databases come back out of a backup of them all |
| `--binding <binding>` | every database in the backup | Restore only the database behind this D1 binding |
| `--database <name>` | the database the stanza names | Restore into a fresh recovery database, `<project>-<env>-<name>`, found by name or created. Needs exactly one database in scope, so pair it with `--binding` when the backup holds several |
| `--group <value>` | a generated timestamp | The migration group the restore's migrate runs under, as `pithy migrate --group` |
| `--json` | `false` | Machine-readable output — one JSON line |

## What it does

Every check runs against every database before anything is written, so a refusal leaves nothing half restored:

1. **The backup is one D1 can take.** A folder `manifest.json` marks `restorable: false` — a row over D1's 100,000-byte statement limit — is refused, naming the file and line and pointing at D1 Time Travel.
2. **Its migrations are exactly this CLI's.** The backup's `migrations.json` is compared with every migration this project would apply to the database. **Any difference, either way, is a refusal** naming the kit version that took the backup, this one, and the keys only one side has. A dump is only good against the schema it came from, so restoring across versions means running `pithy restore` from the version that took it.
3. **The database is empty.** One holding any table is refused, naming the tables. Overwriting live data is D1 Time Travel's job: it works in place and can be undone.

Then, per database:

1. Claim it for this project and run `pithy migrate` into it, which makes every kit table and index.
2. Make the tables and views no migration owns, from `schema.sql`.
3. Load `data.sql` with every trigger out of the way. Rows of one table load as multi-row statements under D1's limit, parents before the tables that reference them, with foreign keys enforced. Loading fires no trigger.
4. Put the migrations' triggers back, then make the indexes and triggers no migration owns, from `schema.sql`.
5. Rebuild what the backup left out. Support's FTS5 index comes back through `provisionSearchIndex`, the code `pithy support provision` runs: the table, its three triggers, and a backfill from `pithy_support_messages`, so search answers what it answered before. Any other virtual table is made again from its recorded `CREATE` statement, with the recorded triggers that write into it, **empty**, and named in the output: only you know how to refill it.

### What it records

Outside `dev`, when the project composes `audit`, a restore records `restore/loaded` (severity `critical`) once every database has loaded: who ran it, the environment, and each database's binding, target, table and row counts, plus the recovery database's id when there is one. Rebuilding support's index records the event `pithy support provision` does, `support/search_index_created` or `support/search_triggers_repaired`. Nothing is recorded before the load, because the trail lives in the app database and a row there would make the restore's own emptiness check refuse it. A recovery database `--database` creates is recorded at once, as `restore/recovery_database_created`: it exists from then on, whatever the restore does next.

### Restoring into a recovery database

`--database recovery` restores into `<project>-<env>-recovery` — created when it does not exist, through `@pithy-sh/cloudflare` with `D1 Write`, which the `ci-system` profile already carries. It is found or created only after the first two checks pass and every backup folder is matched to a database the Workers bind, so a refused backup creates nothing in the account. It is still refused unless it is empty. The run prints its id; point the binding's `database_id` at it in `wrangler.jsonc` and deploy to use it. In `dev` it is a local store of that name.

## `--json`

One line on stdout.

| key | type | meaning |
|---|---|---|
| `command` | string | `"restore"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `project` | string | The project restored. |
| `env` | string | The environment restored into. |
| `recovery` | object | The recovery database `--database` restored into. Absent without the flag. |
| `recovery.name` | string | The D1 `database_name`, `<project>-<env>-<name>`. |
| `recovery.id` | string | Its `database_id`, or the local store's id for `dev`. |
| `recovery.created` | boolean | Whether this run created it. |
| `databases` | object[] | One entry per database restored, in fan-out order. |
| `databases[].binding` | string | The D1 binding, as `wrangler.jsonc` declares it. |
| `databases[].database` | string | The database name — a capability's `databases` key. |
| `databases[].target` | string | The database written to: the remote `database_id`, or the local store's id. |
| `databases[].migrations` | integer | How many migrations were applied before the rows loaded. |
| `databases[].tables` | integer | How many tables' rows were loaded. |
| `databases[].rows` | integer | How many rows were loaded, as the backup's manifest counts them. |
| `databases[].rebuilt` | object[] | Every virtual table brought back after the load. |
| `…rebuilt[].name` | string | The virtual table's name. |
| `…rebuilt[].how` | string | `"provisioned"`: rebuilt and backfilled through the capability's own provisioning. `"recreated-empty"`: made again from its recorded statement, with no rows. |

## Errors

Every refusal writes nothing.

- **`<binding>: this backup holds a row over D1's 100,000-byte statement limit, so D1 cannot take it back.`** Exit 3. Recover in place with D1 Time Travel, or import the files into SQLite with `sqlite3`.
- **`<binding>: the backup was taken by kit <version> and this is <version>, and their migrations differ.`** Exit 3. The message lists the keys only the backup has and the keys only this CLI has. Run `pithy restore` from the version that took the backup.
- **`<binding> (<id>) is not empty. It holds <tables>.`** Exit 3. Restore into a fresh database with `--database <name>`.
- **`--database restores one database, and this backup holds several.`** Exit 2. Add `--binding`.
- **`No database in <env> is bound to <binding> (<database>).`** Exit 3. A backup folder names a database no Worker in scope binds. Bind it, or pass `--binding` to restore the others.
- **`<binding> (<database>) is <n> databases here, one each for <workers>.`** Exit 2. Two Workers bind a database of that name to that binding. Pass `--worker`, and the folder of the database to restore into it.
- **`<n> folders in this backup would restore into <binding> (<database>).`** Exit 2. Pass the one folder to restore.
- **`<dir> holds no backup of a database <worker> binds.`** Exit 3. `--worker` names a Worker that binds none of the backup's databases.
- **`<dir> holds no backup.`** Exit 3, and **`<file> is not a backup file.`** Exit 2. Point it at the directory `pithy backup` wrote, unchanged.

## Examples

```bash
# Restore the backup's DB database into a fresh dev store, <project>-dev-restored.
pithy restore backups/prod-2026-10-27T12-00-00Z --binding DB --database restored

# Restore production's app database into a recovery database, then point DB at it.
pithy restore backups/prod-2026-10-27T12-00-00Z --env prod --binding DB --database recovery --json
```

```text
DB  14 migrations, 12 tables, 340 rows restored.
DB: pithy_support_search rebuilt and backfilled.
Restored into acme-prod-recovery (<database-id>). Point DB's database_id at it in wrangler.jsonc to use it.
Done.
```

```json
{"command":"restore","schemaVersion":1,"project":"acme","env":"prod","recovery":{"name":"acme-prod-recovery","id":"<database-id>","created":true},"databases":[{"binding":"DB","database":"app","target":"<database-id>","migrations":14,"tables":12,"rows":340,"rebuilt":[{"name":"pithy_support_search","how":"provisioned"}]}]}
```
