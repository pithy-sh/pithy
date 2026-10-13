# pithy alias

_The site renders this for readers: [pithy.sh/docs/cli/commands/alias](https://pithy.sh/docs/cli/commands/alias). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Install, remove, or report the `p.` shell shortcut for `pithy`.

## Synopsis

```
pithy alias [--json]
pithy alias --remove [--json]
pithy alias --status [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--remove` | boolean | `false` | Uninstall the alias |
| `--status` | boolean | `false` | Report whether the alias is installed |
| `--json` | boolean | `false` | Machine-readable output |

No flags installs. `--remove` and `--status` are mutually exclusive.

## What it does

Two characters, ending in the brand mark: `p.` — `p. init`, `p. add auth`, `p. deploy`.

**Detect the shell**, from `basename($SHELL)` plus the platform, and resolve where its alias line belongs.

| Shell | rc file | Alias syntax |
|---|---|---|
| bash | `~/.bashrc`, or `~/.bash_profile` on macOS when it exists | `alias p.='pithy'` |
| zsh | `~/.zshrc` | `alias p.='pithy'` |
| fish | `~/.config/fish/config.fish` | `alias p. pithy` |
| nushell | `~/.config/nushell/config.nu` | `alias p. = pithy` |
| PowerShell | The `$PROFILE` PowerShell itself reports: PowerShell 7 (`pwsh`)'s, and on Windows also Windows PowerShell 5.1's | `function p. { pithy @args }` |

PowerShell gets a function rather than an alias because `Set-Alias` rejects a `.` in a name. On Windows its rc file is a set of two: PowerShell 7 (`pwsh`) loads one profile and Windows PowerShell 5.1, which ships with Windows, loads another, and no file loads in both. So the block goes into both, and a family that is not installed holds an inert block until it is. pwsh on macOS or Linux has one profile.

**Where each profile lives is PowerShell's answer, not a guess.** `Documents` may be redirected — OneDrive does it — and `$PROFILE` follows it, so `pithy alias`, `--status`, `--remove` and `pithy doctor` each ask every edition for its own `$PROFILE`: `pwsh -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $PROFILE"`, with a 10-second timeout and no shell. On Windows, 5.1 is run from its System32 path, and `pwsh` only when `PATH` resolves it to an executable. An edition that cannot be run, exits non-zero, times out, or prints anything other than exactly one absolute `.ps1` path (on Windows, a drive or UNC path) falls back to its platform default:

| Edition | Fallback |
|---|---|
| PowerShell 7 on Windows | `~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` |
| Windows PowerShell 5.1 | `~\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` |
| `pwsh` on macOS and Linux | `~/.config/powershell/Microsoft.PowerShell_profile.ps1` |

A block an earlier version wrote to a guessed path that is not the one PowerShell reports — `~/Documents/PowerShell/…` on macOS or Linux, or an un-redirected `Documents` — stays where it is. It is inert, `--status` does not read it, and `--remove` does not delete it; remove it by hand if you want it gone.

macOS bash prefers `.bash_profile` — the platform convention — and falls back to `.bashrc` only when it is absent.

**Write a delimited block**, never a bare line.

```
# >>> pithy alias >>>
alias p.='pithy'
# <<< pithy alias <<<
```

Universal `#` comment syntax, and the markers are what `--remove` finds and deletes. Nothing outside them is touched.

**Idempotent.** A second install detects the existing block — or a hand-added `alias p.=` in any form — and writes nothing. Where the rc file is a set, the install tops it up: a profile without the block gets one, which is how an install from before the second profile is repaired, and the human line names every file written.

**An unrecognized shell is never guessed at.** `pithy alias` prints the POSIX form and how to add it by hand, then exits 0. It writes to no rc file it does not recognize.

`--status` reads only, and names the files that carry the block. It answers on the marker block alone, so a hand-added `alias p.=` reads as *not installed* — the command reports what `--remove` could act on, not what the shell happens to define.

### Two hidden flags

Handled before the command dispatch, so neither is a subcommand and neither appears in `--help`.

`pithy --pithier` is a synonym for `pithy alias`. It installs, with the same human output.

`pithy --pithiest` declines.

```
$ pithy --pithiest
Pithy enough.
```

Exit 0. No alias is installed. The refusal is the point.

Neither hidden flag takes `--json`.

## `--json`

One line, one object. The payload's shape follows the path taken, and there are four. `command` and `action` lead every one of them: `alias` has no subcommands, so `action` is what tells the paths apart.

**Install** — `pithy alias --json`.

```
$ pithy alias --json
{"command":"alias","schemaVersion":1,"action":"install","installed":true,"alreadyInstalled":false,"wrote":["/home/you/.bashrc"],"shell":"bash","rcPath":"/home/you/.bashrc","alias":"alias p.='pithy'"}
```

**Remove** — `pithy alias --remove --json`.

```
$ pithy alias --remove --json
{"command":"alias","schemaVersion":1,"action":"remove","removed":true,"removedFrom":["/home/you/.bashrc"],"rcPath":"/home/you/.bashrc"}
```

**Status** — `pithy alias --status --json`.

```
$ pithy alias --status --json
{"command":"alias","schemaVersion":1,"action":"status","installed":true,"installedIn":["/home/you/.bashrc"],"shell":"bash","rcPath":"/home/you/.bashrc"}
```

**Unknown shell**, from an install or a remove. `action` says which of the two was asked for, and `manual` says nothing was written.

```
$ pithy alias --json
{"command":"alias","schemaVersion":1,"action":"install","shell":null,"manual":true,"alias":"alias p.='pithy'"}
```

`--status` under an unknown shell reports nulls the same way: `{"command":"alias","schemaVersion":1,"action":"status","installed":false,"shell":null,"rcPath":null}`.

This path used to carry no `action` at all — so the one case where the command exited 0 and changed nothing was the one case a consumer keying on `action` could not classify. It is the case that most needs detecting.

| key | type | meaning |
|---|---|---|
| `command` | `"alias"` | The command that produced the line. On every payload |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only by a change that breaks a parser — a key removed, a key retyped, a value added to a fixed set; an added key does not bump it. `pithy schema` publishes the current one. |
| `action` | `"install" \| "remove" \| "status"` | Which path ran. On every payload, the unknown-shell one included |
| `installed` | boolean | Install: always `true` — the alias is in place, whether this run put it there or found it. Status: whether the marker block is in any of the rc files |
| `alreadyInstalled` | boolean | Install only. `true` when the block, or a hand-added `alias p.=`, was already in one of the rc files before this run |
| `wrote` | string[] | Install only, always present. The files this run wrote the block into. `[]` means nothing was written |
| `removed` | boolean | Remove only. `false` when there was no block to remove — not an error, and the exit is 0 |
| `removedFrom` | string[] | Remove only, present when `removed` is `true`. The files the block came out of |
| `installedIn` | string[] | Status only, present when `installed` is `true`. The files that carry the block |
| `shell` | string or `null` | The detected shell family: `bash`, `zsh`, `fish`, `nushell`, `powershell`. `null` when detection failed |
| `rcPath` | string or `null` | Absolute path to the rc file the alias line belongs in — the first, when there are several. `null` on `status` with an undetected shell |
| `rcPaths` | string[] | Present only when the rc file is a set of more than one — PowerShell on Windows. Every member, `rcPath` first |
| `alias` | string | The alias line itself. The shell-specific syntax on the install path; the plain POSIX form on the unknown-shell path |
| `manual` | `true` | Present only on the unknown-shell path, and only from an install or a remove. Says the shell was not detected, nothing was written, and `alias` is for you to add by hand |

`installed`, `alreadyInstalled` and `wrote` answer different questions on the install path: `installed` is the state afterwards, `alreadyInstalled` is whether the alias was there before, and `wrote` is what this run changed. On Windows a run can find the alias in one profile and write it into the other, so `alreadyInstalled` is `true` and `wrote` is not empty.

## Errors

**Both `--remove` and `--status`.** The only error this command raises. Exit 2.

```
$ pithy alias --remove --status
Pass either --remove or --status, not both.
Choose one.
```

Under `--json`:

```
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"Pass either --remove or --status, not both.","action":"Choose one.","exit":2,"retryable":false}}
```

Nothing else here fails. An undetected shell, a missing rc file, and a remove with nothing to remove are all ordinary outcomes with exit 0.

## Examples

Install.

```
$ pithy alias
Added `alias p.='pithy'` to /home/you/.zshrc
Open a new terminal, or run: source /home/you/.zshrc
```

Install again.

```
$ pithy alias
Already pithy.
```

Check.

```
$ pithy alias --status
Installed in /home/you/.zshrc
```

```
$ pithy alias --status
Not installed. Run `pithy alias` to install.
```

Remove.

```
$ pithy alias --remove
Removed `alias p.='pithy'` from /home/you/.zshrc
Open a new terminal, or run: source /home/you/.zshrc
```

```
$ pithy alias --remove
No Pithy alias installed.
```

A shell Pithy does not know.

```
$ pithy alias
Couldn't detect your shell.
Add `alias p.='pithy'` to your shell config to use `p.`.
```

```
$ pithy alias --status
Unable to detect shell.
```

Ask for more.

```
$ pithy --pithiest
Pithy enough.
```
