# pithy seed

Load seed and test data into an environment from the same Zod schemas and codecs that define your tables and KV stores.

## Synopsis

```bash
pithy seed [--worker <name>] [--env <name>] [--dry-run] [--redo] [--yes] \
           [--confirm-production <phrase>] [--confirm-reset <phrase>] [--json]
```

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | every Worker | Seed one Worker instead of every Worker under `apps/` |
| `--env <name>` | `dev` | The environment to seed. `dev` runs locally against Miniflare; anything else runs against the live D1/KV/R2/Images/Stream for that env |
| `--json` | `false` | Machine-readable output — the full write plan or run report as one JSON line. Implies non-interactive: `pithy seed` never prompts when `--json` is set |
| `--dry-run` | `false` | Compute and print the write plan without touching any backend. Reads media sidecars to report `upload`/`skip`/`reupload` accurately; mints nothing |
| `--redo` | `false` | **DESTRUCTIVE.** Drop every table and recreate the schema before seeding — all data is lost. See Resetting data, below |
| `--confirm-reset` | — | Unlock a non-`dev` `--redo`: the exact phrase `yes, i really want to reset <env>` |
| `--yes` | `false` | Confirm a non-`dev` environment. Required for `staging` and `prod`; `dev` never needs it |
| `--confirm-production <phrase>` | — | The non-interactive unlock for `prod` — see The production exception, below |

## What it does

`pithy seed` loads test data into an environment from the same Zod schemas and codecs that define your tables and KV stores — no separate fixture format, no hand-written SQL. Fixtures are authored with `defineSeed` (the peer of `defineCapability`) and composed library-before-app, exactly like migrations. The full authoring model — `defineSeed`, media `once`/`always`, the standard asset-metadata convention, the env-safety layers — is documented in `docs/SEED.md`; this page covers the command itself.

### Idempotency

Every `pithy seed` run is safe to repeat. D1 rows insert with `INSERT OR IGNORE`; KV entries `put` by key; a `once` media asset uploads on its first run only and skips on every run after. Re-running `pithy seed` against an environment that already has the fixtures loaded writes nothing new and changes nothing existing.

This is also why editing a fixture's values and re-running `pithy seed` does nothing: the row already exists, so it is ignored, unchanged. See Resetting data, below.

### Fixture size

Make a fixture as big as the thing it has to prove. A paged list needs more rows than a page, and `DEFAULT_PAGE_SIZE` is 25.

D1 accepts 100 bound parameters in one statement, and an insert binds one per column per row — so a seven-column table fits about fifteen rows per statement. `pithy seed` writes each group in chunks sized from that table's own column count, so the limit is never a fixture's problem and never a number to look up. A 500-row group lands the way a 3-row one does.

A group is not atomic across its chunks. `INSERT OR IGNORE` is what makes that safe: a run that dies partway is re-run, the landed rows are ignored, and the rest go in.

### The production exception

Every other flag in Pithy follows the same rule everywhere: `--json` means non-interactive, full stop. `pithy seed --env prod` is the one place a flag additionally gates *content*, not just interactivity — because seeding production is rare and should stay rare.

- `dev` never asks for anything.
- `staging` (and any other non-`dev`, non-production environment) needs `--yes`.
- `prod` needs `--yes` **and** the exact phrase `yes, i really want to seed production`, matched case-insensitively after trimming. Interactively, `pithy seed` prompts for it with `@clack/prompts`. Non-interactively (`--json`, CI, no TTY), there is no prompt — pass it directly:

  ```
  pithy seed --env prod --yes --confirm-production "yes, i really want to seed production"
  ```

  Get the phrase wrong, or omit it non-interactively, and the run is refused before anything opens:

  ```
  $ pithy seed --env prod --yes --json
  The production confirmation phrase did not match.
  Pass --confirm-production "yes, i really want to seed production" to seed production.
  ```

The flag and the phrase keep the word `production` deliberately. The **environment** is named `prod`, and `--env production` is refused — but a confirmation phrase is read by a human about to overwrite live data, and `yes, i really want to seed prod` is a sentence you can type without meaning it.

Underneath both gates is a third, structural one that no flag can bypass: a seed set is only ever composed for `prod` if it lists `prod` in its own `environments` array. See `docs/SEED.md` for the full layered model.

### Resetting data (`--redo`)

`--redo` is for the moment you edited a fixture's values and want them to actually land. Idempotency (above) means a plain re-seed never refreshes existing rows, so `--redo` exists to force it — but it is **not** a per-row refresh. It is a full schema reset:

1. Roll every migration back — every `down`, not just the latest, in reverse order.
2. Reapply every migration's `up`, recreating the schema empty.
3. Seed as normal.

Because every table the migration registry owns comes back empty, step 3's ordinary non-destructive writes just work — there is nothing left to special-case. There is also nothing left of what was there before: **`--redo` destroys every row in every table the registry owns, not just the rows a fixture wrote.** Data you inserted by hand, in a seeded table, does not survive. This is the sharp edge — reach for `--redo` only when a clean rebuild is actually what you want.

A real reset opens with the banner that names what it just did, then a line per database:

```
$ pithy seed --env dev --redo
DESTRUCTIVE. Every table in dev was dropped and recreated.
Reset app (DB): 1 migration rolled back and reapplied.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

`--redo --dry-run` reports what would be reset and written, and touches nothing — no banner, because nothing was dropped:

```
$ pithy seed --env staging --redo --dry-run
Would reset app (DB): 1 migration.
api  0200_leaderboard_demo_board: 12 rows.
Dry run. Nothing written.
Done.
```

**`--redo` carries its own, stricter gate — it is not the seed gate.** `--yes` means "yes, this is not dev"; it was designed to authorize *writing* seed rows, which is additive and harmless. A reset drops every table first. Letting one flag authorize both would mean a script — or a hand — that knew only to pass `--yes` could destroy an environment's entire dataset. So:

| Environment | Plain seed | `--redo` |
|---|---|---|
| `dev` | free | free — a local Miniflare store is what reset is for |
| `staging`, a feature env, anything non-`dev` | `--yes` | **the exact phrase** `yes, i really want to reset <env>` |
| `prod` (+ any name in `seed.productionEnvironments`) | `--yes` + the seed confirm phrase | the reset phrase, and it is refused headlessly without it |

The phrase **names its environment**, so a phrase authorizing a `staging` reset cannot be pasted into a command targeting another one. Pass it as `--confirm-reset "yes, i really want to reset staging"`; interactively, the prompt states plainly that all data will be lost before asking. Automation is preserved — CI passes the flag explicitly — a reset simply cannot happen by accident.

A non-`dev` reset is **audited**: a `seed/schema_reset` event is recorded at `critical` severity naming the environment and the databases involved. The outcome is always truthful: recorded as `success` once the reset actually completes, or as `failure` — and the command still fails — if it dies partway. A `dev` reset records nothing — auditing covers actions that reach a **remote** system (from a developer's machine, from CI, or in production); a `dev` run only touches the local Miniflare store and changes nothing shared. Auditing is also a no-op when the project does not compose `@pithy-sh/audit`.

## `--json`

`--json` emits the full plan or report as a single line — the same shape either way, one entry per Worker, with `dryRun` telling you which:

```
$ pithy seed --env dev --dry-run --json
{"command":"seed","env":"dev","dryRun":true,"workers":[{"worker":"api","sets":[{"name":"0200_leaderboard_demo_board","d1":[{"database":"app","table":"boardEntries","rows":12}],"kv":[],"r2":[],"media":[]}],"skippedByEnv":[],"shared":[]}],"devSecrets":null}
```

| key | type | meaning |
|---|---|---|
| `command` | string | `"seed"`. |
| `env` | string | The environment seeded. |
| `dryRun` | boolean | Whether the plan was computed and nothing written. |
| `workers` | object[] | The per-Worker outcome, in fan-out order. |
| `workers[].worker` | string | The Worker's name. |
| `workers[].sets` | object[] | The per-set outcome, in run order, each named by its composed key and carrying its `d1`, `kv`, `r2` and `media` writes. |
| `workers[].skippedByEnv` | string[] | The sets the registry carries that this environment disallows — surfaced, never silently dropped. |
| `workers[].shared` | string[] | The sets an earlier Worker in the fan-out already wrote to the same store. Two Workers sharing a binding share one store, so the fixture runs once and the second says so rather than double-counting. |
| `reset` | object[] | Present only with `--redo`: one entry per physical database whose schema was, or would be, reset. |
| `devSecrets` | object \| null | What the dev-secrets pass wrote and which Workers' `.dev.vars` it refused. `null` on a dry run and outside `dev`, where nothing is written. |

## Errors

Every refusal here is a gate rather than a fault, and each one names the flag that opens it.

| Condition | Effect |
|---|---|
| `--env production` | Refused at the flag. The environment is `prod` (§1.2). |
| A non-`dev` environment without `--yes` | Refused before anything opens. |
| `prod` without the confirmation phrase, non-interactively | Refused before anything opens — see the production exception above. |
| A non-`dev` `--redo` without `--confirm-reset "yes, i really want to reset <env>"` | Refused. The phrase names its environment, so one authorizing `staging` cannot be pasted into a command targeting another. |
| A Worker that was supposed to get a generated `.dev.vars` and did not | The fixtures still run — they are the rest of the run and they are worth doing — and the exit code is 1. The refusal names the file and offers `.dev.vars.local`. |

## Examples

A normal run reports one line per seed set, then `Done.`. Every line is prefixed with the Worker that ran it — the run fans out over `apps/*`, so a fan-out over several Workers reads as one list rather than several interleaved ones. Each set is named by its composed key, `NNNN_<capability>_<name>` (see `docs/SEED.md`):

```
$ pithy seed --env dev
api  0100_auth_test_users: 3 rows, 1 entry.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

A set with nothing to write for the current shape still gets a line, so a quiet run is never mistaken for a skipped one:

```
$ pithy seed --env dev
api  0300_media_avatar: nothing to seed.
Done.
```

A set present in the registry but not allowed for the target environment is reported above the sets that ran, never silently dropped:

```
$ pithy seed --env dev
api  skipped 0210_leaderboard_prod_smoke: not allowed in dev.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

`--dry-run` prints the same per-set shape and adds a plain reminder before `Done.`:

```
$ pithy seed --env staging --dry-run
api  0200_leaderboard_demo_board: 12 rows.
Dry run. Nothing written.
Done.
```
