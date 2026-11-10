# pithy remove

_The site renders this for readers: [pithy.sh/docs/cli/commands/remove](https://pithy.sh/docs/cli/commands/remove). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Unwire a capability from one Worker and uninstall its package — the manual, interactive inverse of `pithy add`.

## Synopsis

```
pithy remove <capability> [--worker <name>] [--drop [--env <env>] [--destroy-retained <n>]]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `<capability>` | positional | — | The capability name, e.g. `auth`. Required |
| `--worker <name>` | string | — | Which Worker to unwire it from (`apps/<name>`). Optional in a single-Worker project |
| `--drop` | boolean | `false` | Also roll back the capability's migrations, dropping its tables |
| `--env <env>` | string | `dev` | With `--drop`, the environment whose tables to drop, and the environment the Worker's `pithy.config.ts` is composed for — so the migrations reversed are the ones that environment declares. `dev`, `staging`, `prod`, or a custom name |
| `--destroy-retained <n>` | string | — | With `--drop`. **DESTRUCTIVE.** Let the drop destroy rows in retained tables. Must equal the row count the refusal printed |
| `--json` | boolean | `false` | **Not supported.** Passing it fails before anything is read or changed |

## What it does

The precise inverse of `add` — and of `add --eject` — for one Worker, in this order.

**Refuse if something depends on it.** Another capability wired into the same Worker that requires this one stops the removal, naming the dependents and the order to remove them in.

**Drop the tables, if asked.** First, while the capability's `down` code is still present — after the uninstall there would be nothing left to reverse them with. Gated on a confirmation, and refused outright when a sibling Worker still wires the capability: two Workers declaring one binding share one physical D1 unless one owns it, so reversing migrations for one would delete data the other is serving. Each migration it reverses is named as it starts: `▸ Rolling back 0300_auth_0001_init on DB...`.

**Delete the Worker's own host for the capability.** A Worker that owns a binding the capability's host binds — `DB` for email and audit — had a host of its own, `<project>-<env>-<worker>---<capability>` ([`NAMING.md`](../NAMING.md#a-workers-own-kit-hosts)). Nothing else reaches it, so before the Worker is unwired its Workflows and then its script are deleted in every environment the project declares, found by recomputing their names. The shared host stays: other Workers reach it. A Worker that shares the host has nothing of its own to delete.

**Unwire the Worker.** The import and the registration call come out of `apps/<name>/pithy.config.ts`; the capability's bindings come out of every environment stanza in its `wrangler.jsonc`; and its Durable Object exports come out of the module `main` names — the package is about to be uninstalled, or the fork deleted, so a re-export left behind is a Worker that no longer builds. A binding another capability in that Worker still needs stays, and so does an export of the same class from a module of your own.

**Take out the test bindings.** The test bindings `add` wrote into the project-root `vitest.workers.config.ts` come out again — a property left empty with them, and a value binding's import once nothing else in the file uses it — and are named: `Took SECRETS, SECRETS_ENCRYPTION_KEYS out of vitest.workers.config.ts.` That file is shared by every Worker, so a binding stays while another capability this Worker keeps, or any capability another Worker composes, still declares it, and all of them stay while another Worker composes this capability. The starter's own `DB` and `SESSIONS` always stay. A package only the removed lines imported loses the root `devDependency` `add` declared for it, once no file that resolves through the root imports it — a root config, or a script under a root directory that is not a workspace member such as `scripts/` or `test/` — and `remove` then runs `<pm> install` at the root, before the Worker's uninstall below. A root runtime dependency is never taken out. A project with no `vitest.workers.config.ts` has no config to edit. Either way, the same bindings come off this Worker's `Cloudflare.Env` in `src/cloudflare-test.d.ts`, except one another capability this Worker keeps still declares.

**Core's presence room is the one class a capability binds without shipping.** `PRESENCE_ROOMS`, the `PresenceRoom` export and its class stay while another capability in the Worker still declares a room kind. With the last one they come out, and the class is retired with a `deleted_classes` migration rather than spliced out of the history: a Worker that deployed with it holds its creation tag, and the room stores nothing, so retiring it loses nothing.

**Remove the code.** An ejected capability's local source at `apps/<name>/capabilities/<cap>/` is deleted — through a gate that refuses a symlink at any segment of that path and refuses a path resolving outside the project. A package-served capability is uninstalled with the project's package manager instead, named as it starts: `▸ Running bun remove @pithy-sh/auth...`. It runs where the package is declared — in the Worker's own directory when the Worker is a workspace member whose `package.json` declares it, so the change lands in `apps/<name>/package.json`, and at the project root otherwise, including a package a hand install or an older `pithy add` declared at the root. The package is found the way the Worker resolves it, its own `node_modules` first.

A Worker that is a workspace member declares the package in its own `package.json`, so its uninstall takes out that declaration alone; another Worker that composes the capability keeps its own, and the package manager keeps the package for it. The root `devDependency` a test binding's import needed is not this declaration: it came out with the test bindings above. A package declared at the project root is one declaration every Worker shares, so that one is uninstalled only when **no Worker still imports it**, this one included. Six ways it can stay, and each says so plainly rather than leaving a surprise in `node_modules`: this Worker still imports it for another capability the same package ships, as `pithy remove mcp` keeps `@pithy-sh/auth` while the Worker composes `auth` (`Kept @pithy-sh/auth installed — board still imports it.`); another Worker still wires a root declaration; the project's `vitest.workers.config.ts` still imports it, from a line of your own, since every Workers test loads that file (`Kept @pithy-sh/secrets installed — vitest.workers.config.ts still imports it.`); nothing declared it because a linked checkout provides it (and npm, asked anyway, would prune every linked sibling with it); the capability was ejected, so there was a directory to delete and no dependency to remove; or the package is shared — `controlplane` lives inside `@pithy-sh/core`, which is every capability's dependency and the runtime the app is built on, so removing the seam unwires it and uninstalls nothing.

Idempotent, and never destructive by default. An absent capability is a no-op. Without `--drop`, your data is untouched — a later `pithy add <capability>` reuses the same tables. When the tables are left in place and no sibling Worker needs them, `remove` names the `pithy_<capability>_*` prefix to drop by hand, because the `down` code is gone and no later `pithy` command can reverse them for you.

Audited when it reaches a remote environment: a `--drop --env <remote>`, with Cloudflare credentials resolvable and the Worker composing `audit`. Two actions: `capability/removed` at `info` severity, and `capability/tables_dropped` at `warning` for a `--drop`. With `--drop` the audit record carries the environment being destroyed; without it, `dev`, which makes the emitter inert. An inert emitter reads no credentials, so a plain `remove` or a `--drop --env dev` is not refused by a shell exporting another account's credentials. A remote `--drop` still is.

### Retained tables

Some tables hold rows that exist nowhere else — the secrets vault and the email suppression list — and their capability declares them retained. `remove secrets --drop` or `remove email --drop` refuses while one holds rows, names each table and the count, and drops nothing. So does a drop of **any** capability whose tables live in the same database: the count is taken over every capability the Worker composes and every Worker beside it, because a `down` cannot be read for which tables it drops without running it. Dropping a capability from another database is not counted against the vault. The typed phrase below agrees to the drop; it does not agree to losing credentials. Back the rows up, or pass `--destroy-retained <n>` with the printed count. A database another environment binds is never dropped from one environment. See [`migrate.md`](migrate.md#rolling-back).

### The `--drop` confirmations

Typed at a real terminal. There is no bypass flag.

- **`dev`** asks a yes/no: `Drop <capability>'s tables from dev? This deletes data.`
- **Any other environment** demands the exact phrase — the Cloudflare-dashboard delete pattern. `This deletes <env> data. Type "drop <capability> from <env>" to confirm:`

A mismatch, or a cancel, aborts with zero changes. The confirmation gates the first and only destructive step, so declining costs nothing.

## `--json`

**Rejected.** `pithy remove` is the deliberate exception to the CLI's agent-drivable convention. It is destructive, so it is human-only, and `--json` fast-fails before anything is read or changed. So do `--no-input` and `PITHY_NONINTERACTIVE=1` (see Errors).

```
$ pithy remove auth --json
pithy remove is a manual command. --json is not supported.
A person runs pithy remove at a terminal, naming the capability.
```

Exit 5, `core/person_required`: no call an agent could make instead is the right one. There is no `--json` payload to specify, and there are no keys — errors from this command always render as the terminal problem/action lines, never as `{"error":{…}}`, because it has no machine-readable surface at all.

Automated teardown of an ephemeral environment is a different command. Use the `feature` lifecycle — `pithy feature destroy` — not `remove`.

## Errors

Each one is a `PithyError`: the problem, then the action, on stderr, and the process exits by its kind (`docs/CLI.md` §3.8).

**`--json`.** As above. Raised first, before the environment is validated or the Worker resolved.

**An environment that does not exist.**

```
$ pithy remove auth --drop --env production
"production" is not an environment name in Pithy.
Use `prod`.
```

**`--no-input` or `PITHY_NONINTERACTIVE=1`.** The switch says nobody is at the keyboard, and `remove` belongs to a person, so it is refused the way `--json` is: before anything is read or changed, exit 5, `core/person_required`. Raised right after `--json`. A run that only lacks a terminal is not the switch, and still unwires.

```
$ pithy remove auth --no-input
pithy remove is a manual command, and this run forbids prompts.
`pithy remove auth` deletes a capability's wiring. That is a person's decision, not a fix. Run it at a terminal, without --no-input or PITHY_NONINTERACTIVE.
```

**`--drop` with no terminal.** There is no flag that answers a drop for you, so the run stops before anything is read. Exit 5, `core/person_required`: only a person can confirm a drop.

```
$ pithy remove auth --drop < /dev/null
Dropping auth's tables needs a person to confirm it.
`pithy remove auth --drop --env dev` deletes a capability's wiring and a capability's tables. That is a person's decision, not a fix. Run it at a terminal, without --no-input or PITHY_NONINTERACTIVE.
```

**Several Workers, none named.** With a TTY the command prompts; without one, it raises the same `input/required` refusal `pithy add` does.

```
This project has several workers, so which one to wire is ambiguous.
Pass --worker <name>. Known: relay-deck, relay-tally.
```

**A `--worker` that names nothing.**

```
$ pithy remove auth --worker nope
No worker named "nope".
Run pithy worker list to see this project's workers. Known: replay-board.
```

**Something depends on it.**

```
$ pithy remove secrets
Can't remove secrets — payments depends on it.
Remove payments first, then remove secrets.
```

**`--drop` on tables another Worker is using.**

```
$ pithy remove auth --drop
Can't drop auth's tables — tally still wires it.
Remove auth from tally first, or re-run without --drop to unwire this worker and keep the data.
```

**A registration the unwirer cannot find the end of.** A hand-edited `pithy.config.ts` whose capability call does not close where the writer expects is reported rather than guessed at: `Couldn't find the end of the <name>() registration in pithy.config.ts.` — with `Remove the <name> import and registration by hand.`

**A project with no `name`.** Resolved at the command edge, before anything is read or unwired. A `--drop` reverses migrations against a live database, and the project name is what that database's recorded owner is checked against.

## Examples

Unwire a capability and keep the data.

```
$ pithy remove leaderboard
Removed leaderboard from board.
Uninstalled @pithy-sh/leaderboard.
leaderboard's D1 tables were left in place — your data is safe, and composing leaderboard again with pithy add reuses them. To drop them, remove the pithy_leaderboard_* tables by hand (pass --drop to reverse them during removal).
Done.
```

Unwire it and drop its dev tables.

```
$ pithy remove leaderboard --drop
Drop leaderboard's tables from dev? This deletes data.
```

Drop from a deployed environment. The phrase is typed in full.

```
$ pithy remove leaderboard --drop --env staging
This deletes staging data. Type "drop leaderboard from staging" to confirm:
```

Name the Worker in a project with several.

```
$ pithy remove audit --worker deck
```

A capability that was never there.

```
$ pithy remove leaderboard
leaderboard is not present in board. Nothing to remove.
```

A declined confirmation.

```
Aborted. Nothing changed.
```
