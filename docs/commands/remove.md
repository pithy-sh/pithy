# pithy remove

Unwire a capability from one Worker and uninstall its package — the manual, interactive inverse of `pithy add`.

## Synopsis

```
pithy remove <capability> [--worker <name>] [--drop [--env <env>]]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `<capability>` | positional | — | The capability name, e.g. `auth`. Required |
| `--worker <name>` | string | — | Which Worker to unwire it from (`apps/<name>`). Optional in a single-Worker project |
| `--drop` | boolean | `false` | Also roll back the capability's migrations, dropping its tables |
| `--env <env>` | string | `dev` | With `--drop`, the environment whose tables to drop. `dev`, `staging`, `prod`, or a custom name |
| `--json` | boolean | `false` | **Not supported.** Passing it fails before anything is read or changed |

## What it does

The precise inverse of `add` — and of `add --eject` — for one Worker, in this order.

**Refuse if something depends on it.** Another capability wired into the same Worker that requires this one stops the removal, naming the dependents and the order to remove them in.

**Drop the tables, if asked.** First, while the capability's `down` code is still present — after the uninstall there would be nothing left to reverse them with. Gated on a confirmation, and refused outright when a sibling Worker still wires the capability: Workers sharing a binding name share one physical D1, so reversing migrations for one would delete data the other is serving.

**Unwire the Worker.** The import and the registration call come out of `apps/<name>/pithy.config.ts`; the capability's bindings come out of every environment stanza in its `wrangler.jsonc`; and its Durable Object exports come out of the module `main` names — the package is about to be uninstalled, or the fork deleted, so a re-export left behind is a Worker that no longer builds. A binding another capability in that Worker still needs stays, and so does an export of the same class from a module of your own.

**Remove the code.** An ejected capability's local source at `apps/<name>/capabilities/<cap>/` is deleted — through a gate that refuses a symlink at any segment of that path and refuses a path resolving outside the project. A package-served capability is uninstalled with the project's package manager instead.

The package is the one project-wide part of a removal, so it is uninstalled only when **no other Worker still imports it**. Four ways it can stay, and each says so plainly rather than leaving a surprise in `node_modules`: another Worker still wires it; nothing declared it because a linked checkout provides it (and npm, asked anyway, would prune every linked sibling with it); the capability was ejected, so there was a directory to delete and no dependency to remove; or the package is shared — `controlplane` lives inside `@pithy-sh/core`, which is every capability's dependency and the runtime the app is built on, so removing the seam unwires it and uninstalls nothing.

Idempotent, and never destructive by default. An absent capability is a no-op. Without `--drop`, your data is untouched — a later `pithy add <capability>` reuses the same tables. When the tables are left in place and no sibling Worker needs them, `remove` names the `pithy_<capability>_*` prefix to drop by hand, because the `down` code is gone and no later `pithy` command can reverse them for you.

Audited like `add`, when Cloudflare credentials resolve and the Worker composes `audit`. Two actions: `capability/removed` at `info` severity, and `capability/tables_dropped` at `warning` for a `--drop`. With `--drop` the audit record carries the environment being destroyed; without it, `dev`, which makes the emitter inert.

### The `--drop` confirmations

Typed at a real terminal. There is no bypass flag.

- **`dev`** asks a yes/no: `Drop <capability>'s tables from dev? This deletes data.`
- **Any other environment** demands the exact phrase — the Cloudflare-dashboard delete pattern. `This deletes <env> data. Type "drop <capability> from <env>" to confirm:`

A mismatch, or a cancel, aborts with zero changes. The confirmation gates the first and only destructive step, so declining costs nothing.

## `--json`

**Rejected.** `pithy remove` is the deliberate exception to the CLI's agent-drivable convention. It is destructive, so it is human-only, and `--json` fast-fails before anything is read or changed.

```
$ pithy remove auth --json
pithy remove is a manual command. --json is not supported.
Run pithy remove <capability> at a terminal.
```

Exit 1. There is no `--json` payload to specify, and there are no keys — errors from this command always render as the terminal problem/action lines, never as `{"error":{…}}`, because it has no machine-readable surface at all.

Automated teardown of an ephemeral environment is a different command. Use the `feature` lifecycle — `pithy feature destroy` — not `remove`.

## Errors

Each one is a `PithyError`: the problem, then the action, on stderr, exit 1.

**`--json`.** As above. Raised first, before the environment is validated or the Worker resolved.

**An environment that does not exist.**

```
$ pithy remove auth --drop --env production
"production" is not an environment name in Pithy.
Use `prod`.
```

**Several Workers, none named.** With a TTY the command prompts; without one it raises the same resolution error `pithy add` does.

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
leaderboard's D1 tables were left in place — your data is safe, and a later pithy add leaderboard reuses them. To drop them, remove the pithy_leaderboard_* tables by hand (pass --drop to reverse them during removal).
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
