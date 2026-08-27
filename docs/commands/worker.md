# pithy worker

_The site renders this for readers: [pithy.sh/docs/cli/commands/worker](https://pithy.sh/docs/cli/commands/worker). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Manage the project's Workers under `apps/` — the registry every other command discovers.

## Synopsis

```
pithy worker add <name> [--skip-install] [--json]
pithy worker list [--json]
pithy worker remove <name> [--json]
pithy worker rename <from> <to> [--force] [--json]
pithy worker sync [--worker <name>] [--env <environment>] [--json]
```

`apps/` *is* the registry. There is no hand-maintained list: `pithy dev`, `pithy deploy`, `pithy migrate`, and the rest enumerate `apps/*` and read each Worker's `pithy.worker.jsonc`. Add, remove, or rename a Worker here and the dev set follows automatically.

**Only `rename` reaches Cloudflare, and only to ask a question.** It asks the account which scripts are live under the old name before anything moves; it never writes there. `add`, `list`, `remove`, and `sync` touch no account at all — `sync` in particular writes config and runs no deploy, so it is safe on any branch, at any time, as often as you like. An interactive `worker add` reads the account's zones to offer a domain picker; under `--json` it asks nothing and reads nothing.

## Flags

| Argument / flag | Applies to | Default | Purpose |
|---|---|---|---|
| `<name>` | `add`, `remove` | required | The Worker. `add` takes a new kebab-case name; `remove` takes the name `worker list` shows or the `apps/<dir>` basename |
| `<from> <to>` | `rename` | required | The Worker to rename, and its new kebab-case name |
| `--skip-install` | `add` | `false` | Skip the workspace install after scaffolding |
| `--force` | `rename` | `false` | Rename even though a script is deployed under the old name. It stays live, and the report names it |
| `--worker <name>` | `sync` | resolved | Which Worker to reconcile (`apps/<name>`). A single-Worker project needs no flag; several prompt at a terminal and raise an actionable error under `--json` |
| `--env <environment>` | `sync` | every declared one | Reconcile just this environment — its route, its Workflow bindings, its cron. Omit for the top-level stanza plus every `env.<name>` the Worker already declares |
| `--json` | all five | `false` | One line of machine-readable output |

## What it does

**`add`** scaffolds `apps/<name>/` and wires it in: the Worker's `wrangler.jsonc` (named `<project>-<name>`), its `pithy.worker.jsonc`, its `tsconfig.json`, and its `package.json`. It then generates every discovered Worker's `.dev.vars` — not only the new one, because generation is idempotent by content and a run that changes nothing writes no bytes — takes a port when there is a feature block to take one from, and installs the workspace. At a terminal it also asks where the Worker answers, per environment, against the account's real zones, and writes the answer as a `domains` block. All-or-nothing: anything that fails after the directory is made rolls it back, so the same command works on the retry.

One gap, stated rather than hidden: `add` writes the new Worker's `tsconfig.json` but does **not** add it to the root solution file. Add the reference yourself, or that Worker's source is typechecked by nothing (`docs/CLI.md` §1.3).

**`list`** reports the discovered Workers with their autostart state and pinned dev port. It is the per-Worker view — which Workers exist, which autostart, which port each holds.

**`remove`** deletes `apps/<name>/` and releases its port back to the feature's block. The target is resolved from the discovered set and restricted to `apps/*`, so nothing outside it can be addressed. Your data is untouched: this deletes a directory, not a database.

**`sync`** writes what the Worker's `pithy.config.ts` declares into its `wrangler.jsonc`. Two halves, one job — the declaration is the truth, and this is what makes wrangler agree with it.

The first half is the address. A `domains` block names where the Worker answers per environment, and `sync` writes the `custom_domain` route and the `vars.BASE_URL` it implies. **This is the only non-interactive way to get that route written.** Before it, the route was written by the domain prompt during `pithy init` or `pithy worker add` and nowhere else, so a `domains` block added by hand — the documented way to add an environment — declared an address nothing served: `pithy doctor` reported it healthy, `pithy deploy` shipped it, and the Worker answered on nothing. Doctor now reports that as a missing route and names this command. Running it twice changes nothing and writes nothing.

The second half writes the app capability's declared Workflows and cron triggers, for every environment it declares — the app's equivalent of what `pithy <capability> provision` writes for a library capability's. `docs/CLI.md` §6.5 has the three rules it works by: the app's entries are replaced rather than merged, an entry carrying a `script_name` belongs to a library capability's provisioner and is never touched, `triggers.crons` is set to exactly the declared schedules, and the `WorkflowEntrypoint` subclass stays yours to export from the Worker's `main`. Idempotent, comment-preserving, and all-or-nothing.

**`pithy doctor` and `pithy deploy --env <name>` read that half back.** A declared job that was never synced used to deploy clean and never run, with nothing anywhere saying so; both now report a stanza that does not bind what the app declares, and both name this command. Which is why an app capability declaring **no** Workflows is reconciled too rather than skipped: dropping the last job has to take its binding and its cron out, or the fault would name a command that could not fix it. Nothing is invented for a project that never had either — no empty `workflows` key, no `triggers` block.

**`rename`** is documented in full at `docs/CLI.md` §6.6, and that section is the authority. In short: a Worker's name is three strings that have to agree — the directory `apps/<name>/`, the deployed script name in `wrangler.jsonc` and `package.json`, and `vars.WORKER`, which is what tells two Workers' audit events apart when they share a database. This command moves all three at once, comment-preserving, holding the new name to the same kebab-case rule `add` holds a new one to and refusing a destination that already exists.

Two things it deliberately leaves alone: the app capability's `name` in `pithy.config.ts`, which is a migration namespace stamped into every applied row, and a script name the adopter chose — only a name carrying the Worker segment is recomputed, so a Worker migrated in as `my-service` keeps its name and the command says so.

**A rename after a deploy is not a rename.** Resource names are computed rather than stored, so `<project>-<env>-<binding>` survives untouched — but the Worker script is named for the Worker, so a renamed Worker deploys as a *new* script and leaves the old one live, serving, and billing. So the account is asked first, and a live script under the old name is refused by name. `--force` is how you say that is understood; the report then names exactly what was left behind. Where the account cannot be reached — no credentials, an offline laptop, a token that will not list — the rename proceeds and says it did not check. **It never reports an unchecked account as a clear one**, which is what `accountChecked` exists for.

What `rename` does not touch is everything outside the Worker's own directory: the root `tsconfig.json` references, a vitest config, a CI workflow. Those are yours, they are grep-able, and the command's last line says to look. `pithy doctor` checks the three stamps agree on every run, so a hand-rename that misses one fails CI instead of a deploy.

## `--json`

One line, one object, one shape per subcommand. The `command` field is the subcommand's dotted name, matching `feature.create` and `ui.add` rather than the space-separated form the resource commands use.

**All five subcommands name the Worker the same way.** `worker` is the `apps/` directory — what the adopter typed, what `--worker` accepts, and what every path in the same payload is relative to. `deployedAs` is the script name from `wrangler.jsonc` — what the Cloudflare dashboard shows, and what `wrangler deploy` writes. They are two identities and not interchangeable; a Worker scaffolded as `web` in project `acme` is `web` and `acme-web` at once, and `pithy worker rename` can leave the two unrelated entirely. Read `worker` to act on a Worker, `deployedAs` to find it in an account.

```
$ pithy worker add web --json
{"command":"worker.add","worker":"web","deployedAs":"acme-web","dir":"/repo/apps/web","port":null,"reconciled":false,"devVarsRefused":[],"domains":null}
```

| key | type | meaning |
|---|---|---|
| `command` | `"worker.add"` | The subcommand that produced the line |
| `worker` | `string` | The `apps/` directory the Worker was scaffolded at — the name given on the command line |
| `deployedAs` | `string` | The script name it will deploy under, `<project>-<worker>` as scaffolded |
| `dir` | `string` | The absolute directory the Worker was scaffolded at |
| `port` | `number \| null` | The port pinned for this Worker, or `null` when none was — which is what a plain checkout looks like, since there is no feature block to take one from. Inside a feature worktree it is the port the reconcile just assigned. `pithy worker list` is the authoritative per-Worker port view |
| `reconciled` | `boolean` | Whether the feature's `.dev.config.json` was rewritten. Only ever true inside a feature worktree |
| `devVarsRefused` | `string[]` | One sentence per Worker whose `.dev.vars` this run did not generate — a file pithy did not write, or a directory it may not write into. This command regenerates every Worker it discovers, so a sibling that will not get its bindings is named here |
| `domains` | `object \| null` | The `domains` declaration this run wrote, or `null` when none was. Always `null` under `--json`: the picker is interactive, and a headless run declares `domains` in `pithy.config.ts` directly |
| `domains.staging` | `object` | Where the Worker answers in `staging`, when declared |
| `domains.prod` | `object` | Where the Worker answers in `prod`, when declared |
| `domains.<env>.pattern` | `string` | The hostname |
| `domains.<env>.zone` | `string` | The Cloudflare zone the hostname sits under |

```
$ pithy worker list --json
{"command":"worker.list","workers":[{"worker":"api","deployedAs":"acme-api","dir":"/repo/apps/api","autostart":true,"hasWrangler":true,"port":8787}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"worker.list"` | The subcommand that produced the line |
| `workers` | `object[]` | The discovered Workers, in discovery order |
| `workers[].worker` | `string` | The Worker's `apps/` directory |
| `workers[].deployedAs` | `string` | The Worker's `wrangler.jsonc` `name` — the deployed script name — or the directory basename when the file declares none |
| `workers[].dir` | `string` | The Worker's directory |
| `workers[].autostart` | `boolean` | Whether `pithy dev` starts it. From the Worker's `pithy.worker.jsonc` `dev.autostart`, defaulting to `true` |
| `workers[].hasWrangler` | `boolean` | Whether the directory holds a `wrangler.jsonc`. `false` means a non-Worker process in the dev set, which `pithy deploy` skips |
| `workers[].port` | `number \| null` | The port pinned in `.dev.config.json`, or `null` when none is assigned — a plain checkout, or an unassigned Worker |

```
$ pithy worker remove web --json
{"command":"worker.remove","worker":"web","deployedAs":"acme-web","dir":"/repo/apps/web","reconciled":true}
```

The name argument is matched against either identity, so both `pithy worker remove web` and `pithy worker remove acme-web` find the same Worker. The payload always reports both.

| key | type | meaning |
|---|---|---|
| `command` | `"worker.remove"` | The subcommand that produced the line |
| `worker` | `string` | The removed Worker's `apps/` directory |
| `deployedAs` | `string` | The script name it deployed under — its `wrangler.jsonc` `name`, or the directory basename when it declares none |
| `dir` | `string` | The directory that was deleted |
| `reconciled` | `boolean` | Whether the feature's `.dev.config.json` was rewritten, returning the freed port to the block. Only ever true inside a feature worktree |

```
$ pithy worker rename api board --json
{"command":"worker.rename","worker":"board","deployedAs":"acme-board","from":"api","to":"board","dir":"/repo/apps/board","script":{"from":"acme-api","to":"acme-board"},"orphaned":[],"accountChecked":true,"reconciled":false}
```

`worker` and `deployedAs` describe the Worker **after** the move, so a caller reading the identity keys gets the same two facts here it gets from the other four subcommands. `from`, `to` and `script` are what a rename adds on top: the transition. `deployedAs` is therefore always the script name the Worker deploys under now — including when `script` is `null` because a name the adopter chose was left alone.

| key | type | meaning |
|---|---|---|
| `command` | `"worker.rename"` | The subcommand that produced the line |
| `worker` | `string` | The Worker's `apps/` directory after the move. The same string as `to` |
| `deployedAs` | `string` | The script name it deploys under after the move. The same string as `script.to`, and the unchanged declared name when `script` is `null` |
| `from` | `string` | The `apps/` directory basename before the move |
| `to` | `string` | The new name — the directory, the script's Worker segment, and the `WORKER` var |
| `dir` | `string` | Where the Worker now lives: `apps/<to>` |
| `script` | `object \| null` | The deployed script name before and after, or `null` when the declared name carried no Worker segment to move — a name the adopter chose is kept |
| `script.from` | `string` | The script name as declared before the rename |
| `script.to` | `string` | The script name it deploys under now |
| `orphaned` | `string[]` | Script names left live on the account under the old name. Non-empty only under `--force`. Read it with `accountChecked` — it is empty both when the account said nothing is there and when it said nothing at all |
| `accountChecked` | `boolean` | Whether the account answered. `false` means unchecked, not clear, and `orphaned` then establishes nothing |
| `reconciled` | `boolean` | Whether the feature's `.dev.config.json` was rewritten. Only ever true inside a feature worktree |

```
$ pithy worker sync --worker api --json
{"command":"worker.sync","worker":"api","deployedAs":"acme-api","routes":[{"env":"prod","pattern":"api.example.com","baseUrl":"https://api.example.com","changed":true}],"runs":[{"env":"dev","workflows":[{"binding":"KEY_ROTATION","name":"acme-dev-app-key-rotation","class_name":"KeyRotationWorkflow"}],"crons":["0 4 * * *"],"changed":true}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"worker.sync"` | The subcommand that produced the line |
| `worker` | `string` | The `apps/` directory. What `--worker` accepts, and what sibling paths are relative to |
| `deployedAs` | `string` | The deployed script name, from `wrangler.jsonc`. What the Cloudflare dashboard shows |
| `routes` | `object[]` | One entry per environment the `domains` block declares. Empty when the Worker declares none, or when `--env` names one it does not carry |
| `routes[].env` | `string` | The environment routed. Never `dev` — local answers on the pinned port |
| `routes[].pattern` | `string` | The hostname the `custom_domain` route now points at |
| `routes[].baseUrl` | `string` | What `vars.BASE_URL` now holds: `https://<pattern>` |
| `routes[].changed` | `boolean` | Whether that stanza moved. `false` on a re-run, and nothing is written |
| `runs` | `object[]` | One entry per environment reconciled. Empty when the Worker declares no `app` capability at all; one entry each, binding nothing, when the app declares no Workflows |
| `runs[].env` | `string` | The environment reconciled. `dev` names the top-level stanza |
| `runs[].workflows` | `object[]` | The entries that environment's `workflows` table now declares for the app, verbatim as written |
| `runs[].workflows[].binding` | `string` | The binding name the Worker env exposes, e.g. `KEY_ROTATION` |
| `runs[].workflows[].name` | `string` | The deployed Workflow name, `<project>-<env>-<capability>-<job>` |
| `runs[].workflows[].class_name` | `string` | The exported `WorkflowEntrypoint` subclass that runs the job. Cloudflare resolves it in this script, so it must be exported from the Worker's `main` |
| `runs[].crons` | `string[]` | The cron schedules that environment's `triggers` now carries |
| `runs[].changed` | `boolean` | Whether anything moved. `false` on a re-run with nothing to change |

That split holds across every command that reports a Worker, `pithy add`, `pithy ui` and `pithy upgrade` included. It did not always: `add`, `list`, `remove` and `rename` reported a single `name`, and it was the *directory* in `add` and the *deployed script name* in the other three — one key, two meanings, with nothing in the payload saying which. The two coincide whenever a project and its Worker are named alike, which is what kept it hidden. `name` is gone from all four rather than redefined; a payload carrying both spellings would leave every consumer of the old one reading whichever half it happened to be written against.

## Errors

Each one is a `PithyError` — the problem, then the action. Under `--json` they arrive on stderr as `{"error":{…}}`, and the process exits 1.

**No such Worker.** `remove` and `rename`, when nothing under `apps/` answers to the name.

```
No worker named "wbe" under apps/.
Run pithy worker list to see the workers this project has.
```

**A name that is not kebab-case.** `rename`'s destination is held to the same rule `add` holds a new Worker to.

```
Worker name must be kebab-case (got "Admin_API").
Use lowercase words joined by hyphens, e.g. web or admin-api.
```

**The destination already exists.**

```
apps/board already exists.
Pick another name, or remove that directory first.
```

**A live script under the old name.** The refusal names every script the account reported.

```
api is deployed as acme-api, acme-api-prod.
A renamed worker deploys as a NEW script and leaves that one live and serving. Delete it first, or pass --force to rename anyway and orphan it.
```

**An unreadable `wrangler.jsonc`.** Raised before anything moves — this command edits that file.

```
Could not read api's wrangler.jsonc.
Fix the file, then run the rename again — this command edits it.
```

**Nothing to sync.** `sync` writes what `domains` and an `app` capability declare, and a Worker with neither has nothing to write.

```
api declares neither domains nor an app capability.
Declare `domains` or `app` in the worker's pithy.config.ts. This writes what they imply into wrangler.jsonc — the route and BASE_URL, the Workflow bindings and cron.
```

**A `domains` block that is not valid.** Refused with the field named, rather than written into a `routes` entry Cloudflare rejects at deploy.

**An illegal `--env`.** Checked first, before any config is loaded — an illegal environment costs nothing.

**The project has no name.** `sync` requires `pithy.config.ts`'s `name` and never guesses it: a Workflow name is account-scoped and stable forever once deployed, so a guessed project would name a Workflow another project owns.

**Several Workers, no `--worker`, under `--json`.** The same resolution error `pithy add` raises, naming the Workers it found.

## Examples

Scaffold a second Worker.

```
$ pithy worker add web
Worker web scaffolded at /repo/apps/web.
Ports are assigned when you run pithy feature create or sync.
Done.
```

The same command inside a feature worktree, where there is a port block to take a port from.

```
$ pithy worker add web
Worker web scaffolded at /repo/.worktrees/73-media/apps/web.
Pinned to port 8791.
Done.
```

See what the project has. The deployed script name leads each row; the `apps/` directory follows it, because the two are free to differ and neither can be inferred from the other.

```
$ pithy worker list
acme-api  api  autostart  port 8787
acme-web  web  autostart  port 8788
```

Rename, when nothing is deployed under the old name.

```
$ pithy worker rename api board
Renamed api to board.
Deploys as acme-board, not acme-api.
Check anything outside the worker that names it: tsconfig, CI, imports.
Done.
```

Rename anyway, knowing what is orphaned.

```
$ pithy worker rename api board --force
Renamed api to board.
Deploys as acme-board, not acme-api.
Still deployed under the old name: acme-api. Delete or keep.
Check anything outside the worker that names it: tsconfig, CI, imports.
Done.
```

Reconcile one environment's Workflow bindings.

```
$ pithy worker sync --worker api --env prod
```

Write the route for a `domains` block added by hand, then run it again.

```
$ pithy worker sync --worker api
prod: routed to api.example.com. BASE_URL https://api.example.com.
Done.

$ pithy worker sync --worker api
api is already in sync.
Done.
```
