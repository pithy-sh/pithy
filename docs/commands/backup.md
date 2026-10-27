# pithy backup

_The site renders this for readers: [pithy.sh/docs/cli/commands/backup](https://pithy.sh/docs/cli/commands/backup). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Back up every D1 an environment's Workers bind, off Cloudflare as plain files that `pithy restore` brings back.

## Synopsis

```bash
pithy backup [--env <name>] [--worker <name>] [--binding <binding>] [--output <dir>] [--json]
```

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--env <name>` | `dev` | The environment to back up. `dev` reads the local Miniflare stores; anything else reads the remote databases over the D1 REST API |
| `--worker <name>` | every Worker | Back up only the databases this Worker binds |
| `--binding <binding>` | every database | Back up only the database behind this D1 binding |
| `--output <dir>` | `backups/<env>-<timestamp>` | The directory to write. Created when absent, and refused when it already holds anything: a backup never writes over another |
| `--json` | `false` | Machine-readable output — one JSON line |

## What it does

`pithy backup` finds the databases the way `pithy migrate` does: every D1 binding in every Worker under `apps/`, read from that environment's `wrangler.jsonc` stanza. A database two Workers share, or one every environment shares such as email's suppressions, is backed up once. Each database gets its own folder under `--output`, named for its binding. Where two Workers bind two databases to one binding, each folder is `<binding>-<database>`, and `<binding>-<database>-<id>` where those databases share a name too, so no folder is ever written twice. Each holds four files:

- **`migrations.json`** — what the dump is for: the kit version that took it, the project, the environment, the binding, the database it came from, and every migration it had applied, in the order migrate applied them.
- **`data.sql`** — every table's rows and nothing else, one `INSERT` per row and one row per line, parents before the tables that reference them. Migrate's own bookkeeping tables are left out, because migrate writes them. Every value is read with SQLite's own `quote()`, so an integer stays an integer, a real keeps its precision and a blob stays a blob. A string holding a line break keeps its row on one line: inside the quoted string `~` is written `~0`, a line feed `~n` and a carriage return `~r`, and three nested `replace()` calls put them back. That costs one byte per break, so a long reply with paragraphs in it stays well under D1's limit.
- **`schema.sql`** — the `CREATE` statements of what no migration makes: a table you made by hand, an index you added to a kit table, a trigger. Each sits under a `-- pithy:before` or `-- pithy:after` marker that says whether a restore runs it ahead of the rows or behind them. It holds only its header when there is nothing.
- **`manifest.json`** — every table with its row count, everything left out and why, every virtual table left out with its `CREATE` statement, and whether D1 can take the files back.

The schema itself is not dumped. It comes from the migrations: `pithy restore` runs `pithy migrate` into the empty database first, and the migrations make every kit table and index again. Which names the migrations own is found by running the database's own applied migrations into an empty in-memory D1, so it is never a guess from a name.

### What it leaves out, and why that is safe

A plain `wrangler d1 export` fails outright on a database holding an FTS5 table. `pithy backup` reads rows with `SELECT` instead, and leaves out, found from the schema rather than from a name:

- every virtual table, and each of its shadow tables — SQLite's own `PRAGMA table_list` says which they are, so support's `pithy_support_search_data` is left out and your own FTS5 table is too, whatever it is called;
- Cloudflare's `_cf_*` tables and SQLite's `sqlite_*` tables;
- every trigger whose SQL names a virtual or shadow table, since it would fail every write until its table is back.

Nothing in those is data. Support's index is derived from `pithy_support_messages`, and `pithy restore` rebuilds it through the code `pithy support provision` runs. A virtual table of your own is recorded with its `CREATE` statement and the triggers that write into it, and comes back empty.

### A live database, read page by page

Each table is read 200 rows at a time, every page asking for the rows after the last key it read — `rowid`, or the primary key of a `WITHOUT ROWID` table. A row deleted or added while the backup runs therefore never shifts another out of the dump or into it twice. The backup is still not a snapshot: each page is its own read, and the tables are read one after another, so a write between two reads can leave a child row whose parent the dump missed, or the other way round. For a copy consistent to one moment, use D1 Time Travel; to back up a busy database with `pithy backup`, run it when writes are quiet.

### Who can read it

The files hold every row: your users' emails, live session tokens, OAuth tokens and password hashes. So every folder is made `0700` and every file `0600`, readable by the account that ran the backup and no one else, and an empty `--output` directory you made yourself is closed to `0700` too. A project scaffolded by `pithy init` ignores `backups/` in `.gitignore`; a project made before that line existed should add it, and so should any `--output` inside the checkout.

### A row too long for D1

D1 refuses a statement of 100,000 bytes or more, and `data.sql` writes each row as one statement. A row that long is kept, because the files are still a complete copy `sqlite3` can import. The run names each such row by file and line, marks the database `restorable: false` in `manifest.json`, and exits 1, so a CI job that backs up notices. `pithy restore` refuses that folder and points at D1 Time Travel.

### What it records

Outside `dev`, a backup takes every row out of the account, so it records `backup/exported` in the project's audit trail when the project composes `audit`: who ran it, the environment, and each database's binding, id, table and row counts. Never a row's content. A backup that fails part way records the same event with outcome `failure`. A `dev` backup reads local stores only and records nothing.

### While it runs

Each database is named as it starts: `▸ Backing up DB (app)`. `--json` prints none of it.

## `--json`

One line on stdout.

| key | type | meaning |
|---|---|---|
| `command` | string | `"backup"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `project` | string | The project backed up — the root `pithy.config.ts` `name`. |
| `env` | string | The environment backed up. |
| `output` | string | The directory the backup was written to, as passed or as it defaulted. |
| `restorable` | boolean | Whether D1 can take every database back. `false` exits 1, with the files kept. |
| `databases` | object[] | One entry per database, in fan-out order. |
| `databases[].binding` | string | The D1 binding, as `wrangler.jsonc` declares it. |
| `databases[].database` | string | The database name — a capability's `databases` key. |
| `databases[].folder` | string | Its folder under `output`. |
| `databases[].tables` | integer | How many tables' rows were dumped. |
| `databases[].rows` | integer | How many rows were dumped, across them all. |
| `databases[].virtualTables` | string[] | Every virtual table left out. A restore rebuilds or recreates each. |
| `databases[].restorable` | boolean | Whether D1 can take this database back. |
| `databases[].oversized` | object[] | Every row over D1's statement limit. Empty when `restorable`. |
| `…oversized[].file` | string | The file holding it: `data.sql`. |
| `…oversized[].line` | integer | The line its `INSERT` is on. |
| `…oversized[].table` | string | The table the row belongs to. |
| `…oversized[].bytes` | integer | The statement's size in bytes. |

## Errors

- **`<dir> already holds files.`** Exit 2. Pass `--output` with a new or empty directory.
- **`No database in scope is bound to "<binding>".`** Exit 3. `--binding` matched nothing; the refusal lists the bindings that do exist.
- **`wrangler.jsonc env.<env> has no database_id for the "<binding>" binding.`** Exit 3. The environment is not provisioned; run `pithy provision --env <env>`.
- **`Cloudflare credentials are missing.`** Exit 3, outside `dev`. Run `pithy cloudflare connect`, or set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs `D1 Read`, which the `ci-system` profile carries.
- **A row over D1's statement limit** is not an error line: the report names it, the files are written, and the run exits 1.

## Examples

```bash
# Every database production binds, into backups/prod-<timestamp>/.
pithy backup --env prod

# One database, into a directory CI uploads.
pithy backup --env prod --binding DB --output ./artifacts/db --json
```

```text
DB                  12 tables, 340 rows. Left out, rebuilt on restore: pithy_support_search.
EMAIL_SUPPRESSIONS  1 table, 1 row.
Written to backups/prod-2026-10-27T12-00-00Z.
Done.
```

```json
{"command":"backup","schemaVersion":1,"project":"acme","env":"prod","output":"backups/prod-2026-10-27T12-00-00Z","restorable":true,"databases":[{"binding":"DB","database":"app","folder":"DB","tables":12,"rows":340,"virtualTables":["pithy_support_search"],"restorable":true,"oversized":[]}]}
```

Copying the folder offsite is yours or CI's to do: the command never uploads anything. A backup holds your users' rows, so keep it where you keep the database's credentials. It covers D1 only; KV, R2 and Durable Object storage are not in it. [pithy.sh/docs/build/operations/backups](https://pithy.sh/docs/build/operations/backups) is the guide: D1 Time Travel first, then this command, then the bare `wrangler` route.
