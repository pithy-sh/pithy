# pithy completion

_The site renders this for readers: [pithy.sh/docs/cli/commands/completion](https://pithy.sh/docs/cli/commands/completion). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Tab completion for `pithy`, in bash, zsh, fish and PowerShell. Install it, remove it, report it, or print one shell's script.

## Synopsis

```
pithy completion [--json]
pithy completion --remove [--json]
pithy completion --status [--json]
pithy completion <shell> [--json]
```

## Arguments

| Argument | Meaning |
|---|---|
| `shell` | Print this shell's script instead of installing: `bash`, `zsh`, `fish` or `powershell` |

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--remove` | boolean | `false` | Uninstall completion |
| `--status` | boolean | `false` | Report whether completion is installed |
| `--json` | boolean | `false` | Machine-readable output |

No shell and no flag installs. `--remove` and `--status` are mutually exclusive, and neither takes a shell.

## What it does

**Completion needs `pithy` on the PATH.** It attaches to the binary the shell finds as `pithy`, and only to that. `bun run pithy`, `bunx pithy` and `npx pithy` start another program first and complete nothing.

**The script asks the binary.** On Tab it hands the hidden `pithy __complete` the line up to the cursor and offers what comes back. The script holds no list of commands, so it never goes stale: a command added to the CLI completes the day it ships. `pithy __complete` walks the tree the binary dispatches on, as far as the typed words reach and no further, so a Tab loads only the commands on its path.

**What completes.**

| You type | It offers |
|---|---|
| `pithy <Tab>` | Every top-level command |
| `pithy secrets <Tab>` | That command's subcommands, with their descriptions where the shell shows one |
| `pithy dev --<Tab>` | That command's flags, then the flags every command takes. A flag already typed is not offered again |
| `--env <Tab>` | `dev`, `staging`, `prod` |
| `--worker <Tab>`, `--app <Tab>` | The project's Workers, by their `apps/` directory |
| `pithy add <Tab>`, `pithy remove <Tab>` | The capabilities, each with why a project would enable it |
| `pithy env <Tab>` | The environments |
| `pithy feature destroy --branch <Tab>` | The repository's local `feature/` branches |
| a flag with a fixed set | That set |

`--env=st<Tab>` completes in the spelling it was typed in. A flag whose value only you know, and a positional such as a secret's name, complete nothing rather than a file name nobody asked for.

**Offline, always.** A Tab never resolves a credential, never reaches a Cloudflare account and never writes a file. Values that need a network — secret names in a Secrets Store, Cloudflare resources, deployed versions — are not offered. Outside a Pithy project, the project's values complete nothing. A failure of any kind completes nothing and prints nothing.

**`p.` too.** The scripts cover `p.`, the shortcut `pithy alias` installs, and call `pithy` for it: `p. <Tab>` completes as `pithy <Tab>` does. bash, zsh and PowerShell register `p.` by name; fish's `alias p. pithy` wraps `pithy` and inherits its completion.

**Install the way `pithy alias` does.** `pithy completion` detects the shell exactly as `pithy alias` does and writes into the same rc file — for PowerShell, the same set of profiles. It writes one delimited block holding the line that loads the script.

| Shell | rc file | Line |
|---|---|---|
| bash | `~/.bashrc`, or `~/.bash_profile` on macOS when it exists | `if command -v pithy >/dev/null 2>&1; then eval "$(pithy completion bash)"; fi` |
| zsh | `~/.zshrc` | `if command -v pithy >/dev/null 2>&1; then eval "$(pithy completion zsh)"; fi` |
| fish | `~/.config/fish/config.fish` | `if type -q pithy; pithy completion fish \| source; end` |
| PowerShell | The `$PROFILE` PowerShell reports: PowerShell 7's, and on Windows also Windows PowerShell 5.1's | `if (Get-Command pithy -ErrorAction SilentlyContinue) { pithy completion powershell \| Out-String \| Invoke-Expression }` |

Each line does nothing where there is no `pithy`, so a shell still starts cleanly after it is uninstalled. In zsh the script loads `compinit` itself when the rc file has not loaded it before the block.

```
# >>> pithy completion >>>
if command -v pithy >/dev/null 2>&1; then eval "$(pithy completion zsh)"; fi
# <<< pithy completion <<<
```

`--remove` finds those markers and deletes the block, and nothing outside it. A second install writes nothing, and neither does an install where a line running `pithy completion <shell>` is already there by hand. `--remove` leaves such a line alone: it is yours. `--status` reads only, and names the files that carry the block.

**Wire it up by hand** with `pithy completion <shell>`, which prints the script. Load it from the shell's startup file with the line in the table above, or save what it prints wherever your shell reads completions.

**nushell is not covered.** `pithy alias` supports it; its completion model is different. In nushell, or a shell nobody detected, `pithy completion` writes nothing and says how to load a script by hand, then exits 0.

**`pithy init` offers it.** One question, once, after the alias question, under the same rules: never under `--json`, `--no-input`, `PITHY_NONINTERACTIVE=1` or without a TTY. A yes installs it silently. See `pithy init`.

`pithy completion` runs at every shell's start, so it is the one command after which the update notifier never speaks and before which no Cloudflare session is renewed.

## `--json`

One line, one object. `command` and `action` lead every payload; `action` says which path ran.

**Script** — `pithy completion <shell> --json`.

```
$ pithy completion fish --json
{"command":"completion","schemaVersion":1,"action":"script","shell":"fish","source":"# Tab completion for pithy, in fish. …"}
```

**Install** — `pithy completion --json`.

```
$ pithy completion --json
{"command":"completion","schemaVersion":1,"action":"install","installed":true,"alreadyInstalled":false,"wrote":["/home/you/.zshrc"],"shell":"zsh","rcPath":"/home/you/.zshrc","line":"if command -v pithy >/dev/null 2>&1; then eval \"$(pithy completion zsh)\"; fi"}
```

**Remove** — `pithy completion --remove --json`.

```
$ pithy completion --remove --json
{"command":"completion","schemaVersion":1,"action":"remove","removed":true,"removedFrom":["/home/you/.zshrc"],"rcPath":"/home/you/.zshrc"}
```

**Status** — `pithy completion --status --json`.

```
$ pithy completion --status --json
{"command":"completion","schemaVersion":1,"action":"status","installed":true,"installedIn":["/home/you/.zshrc"],"shell":"zsh","rcPath":"/home/you/.zshrc"}
```

**A shell completion does not cover**, from an install or a remove. `manual` says nothing was written.

```
$ pithy completion --json
{"command":"completion","schemaVersion":1,"action":"install","shell":"nushell","manual":true}
```

`--status` there reports `{"command":"completion","schemaVersion":1,"action":"status","installed":false,"shell":"nushell","rcPath":null}`. With no shell detected, `shell` is `null`.

| key | type | meaning |
|---|---|---|
| `command` | `"completion"` | The command that produced the line. On every payload |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only by a change that breaks a parser — a key removed, a key retyped, a value added to a fixed set; an added key does not bump it. `pithy schema` publishes the current one. |
| `action` | `"script" \| "install" \| "remove" \| "status"` | Which path ran. On every payload |
| `source` | string | Script only. The script's source, exactly as it prints without `--json` |
| `installed` | boolean | Install: always `true` — completion is loaded from the rc file, whether this run put it there or found it. Status: whether the block is in any of the rc files |
| `alreadyInstalled` | boolean | Install only. `true` when the block, or a line running `pithy completion <shell>`, was already there before this run |
| `wrote` | string[] | Install only, always present. The files this run wrote the block into. `[]` means nothing was written |
| `line` | string | Install only. The loading line inside the block |
| `removed` | boolean | Remove only. `false` when there was no block to remove — not an error, and the exit is 0 |
| `removedFrom` | string[] | Remove only, present when `removed` is `true`. The files the block came out of |
| `installedIn` | string[] | Status only, present when `installed` is `true`. The files that carry the block |
| `shell` | string or `null` | The shell: `bash`, `zsh`, `fish`, `powershell`; `nushell` when that is what was detected; `null` when nothing was |
| `rcPath` | string or `null` | Absolute path to the rc file — the one `pithy alias` uses, the first when there are several. `null` on `status` in a shell completion does not cover |
| `rcPaths` | string[] | Present only when the rc file is a set of more than one — PowerShell on Windows. Every member, `rcPath` first |
| `manual` | `true` | Present only when nothing could be written: a shell completion does not cover, or none detected |

## Errors

**An unknown shell.** Exit 2.

```
$ pithy completion tcsh
No completion for tcsh.
Pass bash, zsh, fish or powershell.
```

**Both `--remove` and `--status`.** Exit 2.

```
$ pithy completion --remove --status
Pass either --remove or --status, not both.
Choose one.
```

**A shell with `--remove` or `--status`.** Exit 2.

```
$ pithy completion zsh --status
Pass a shell or --status, not both.
Run `pithy completion <shell>` to print a script, or drop the shell.
```

Under `--json`, each is the one `validation/invalid_input` error line on stderr.

```
{"error":{"code":"validation/invalid_input","status":400,"issues":[{"path":["shell"],"message":"Pass bash, zsh, fish or powershell.","code":"invalid_value"}],"message":"No completion for tcsh.","action":"Pass bash, zsh, fish or powershell.","exit":2,"retryable":false}}
```

An rc file that cannot be read or written is refused with the file named and how to add the line by hand, as `pithy alias` refuses it. An undetected shell, a missing rc file, and a remove with nothing to remove are ordinary outcomes with exit 0.

## Examples

Install.

```
$ pithy completion
Added completion to /home/you/.zshrc
Open a new terminal, or run: source /home/you/.zshrc
```

Install again.

```
$ pithy completion
Already pithy.
```

Check.

```
$ pithy completion --status
Installed in /home/you/.zshrc
```

```
$ pithy completion --status
Not installed. Run `pithy completion` to install.
```

Remove.

```
$ pithy completion --remove
Removed completion from /home/you/.zshrc
Open a new terminal, or run: source /home/you/.zshrc
```

```
$ pithy completion --remove
No Pithy completion installed.
```

Print a script, and load it by hand.

```
$ pithy completion bash > ~/.local/share/bash-completion/completions/pithy
```

A shell completion does not cover.

```
$ pithy completion
Completion covers bash, zsh, fish and PowerShell. Not nushell.
Run `pithy completion <shell>` and load what it prints from your shell's startup file.
```

Use it.

```
$ pithy se<Tab>
secrets  seed  setup
$ pithy migrate --env <Tab>
dev  staging  prod
```
