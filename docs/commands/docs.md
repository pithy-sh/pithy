# pithy docs

_The site renders this for readers: [pithy.sh/docs/cli/commands/docs](https://pithy.sh/docs/cli/commands/docs). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Point your AI coding agent at the Pithy documentation server.

## Synopsis

```
pithy docs connect [--client <id> | --all] [--scope <project|user>] [--config-dir <path>] [--json]
pithy docs connect --print [--client <id>] [--scope <project|user>] [--config-dir <path>] [--json]
pithy docs disconnect [--client <id> | --all] [--scope <project|user>] [--config-dir <path>] [--json]
pithy docs status [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--client <id>` | string | — | One client, by the id in the table below |
| `--all` | boolean | `false` | Every client detected on this machine |
| `--scope <project\|user>` | string | — | `project` writes the repository's file; `user` writes your own |
| `--config-dir <path>` | string | — | The profile directory to write, over `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Only with `--client claude-code` or `--client codex` and `--scope user` |
| `--print` | boolean | `false` | `connect` only. Print the snippet and write nothing |
| `--json` | boolean | `false` | Machine-readable output |

`--client` and `--all` are mutually exclusive. `--scope` is required whenever nothing can be asked — a run under `--json`, `--no-input` or `PITHY_NONINTERACTIVE=1`, or with no terminal attached — and so is `--client` or `--all`. Each refusal is `input/required`, naming the flag and every value it takes (`docs/CLI.md` §1.2).

`--config-dir` names one client's profile, so it needs `--client` naming a client a variable moves — `claude-code` or `codex` — and `--scope user`. Any other use is refused, exit 2, as `validation/invalid_input` naming why, before anything is read or written. The directory has to exist — a profile's directory is there once its tool has run, so a missing one is a typo, and writing it anyway would create a profile nobody runs — and it cannot start with `~`, which the shell leaves unexpanded after `--config-dir=` and which would otherwise name a directory called `~` inside the project. A bad `--scope`, or `--client` beside `--all`, is named before any of these.

`disconnect` takes the same target flags without `--print`. `status` takes `--json` and nothing else: it reads.

## What it does

The server is [`https://pithy.sh/mcp`](https://pithy.sh/mcp). It answers questions about Pithy — the capabilities, the config surface, the naming rules, this reference — so an agent working in your repository reads the current documentation instead of guessing from its training data.

Every client in the table below can be pointed at it. They disagree on the file, the syntax, the key and the spelling of the address, and none of that is your problem: `pithy docs connect` writes each one in its own vocabulary.

**One key, merged in.** The entry is written under the name `pithy`, and that is the only name this command sets and the only name `disconnect` removes. Everything else in the file — your own MCP servers, an editor's settings, Claude Code's session state — is read, kept, and written back unchanged. This is not a manager for your other servers, and each refusal below exists to keep that true.

**Nothing is guessed at.** A document that will not parse is left byte-identical on disk, the row says `refused` with the reason, and the snippet to paste is printed under it. A best-effort write into a half-written `~/.claude.json` is a tool that stops working tomorrow with no way back to today.

**A project file stays inside the project.** A project path is composed from a root you did not write — a repository you cloned — so every segment of it is somebody else's content. If `.zed`, or `.continue/mcpServers`, or the config file itself turns out to be a symlink, the write is refused and named rather than followed. A repository could otherwise ship `.cursor/mcp.json` as a link to anywhere you can write, and the first `--scope project` run would create or overwrite that file instead. User paths are not held to this: a user path is your home, or the directory your `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `--config-dir` names, and every link in it is yours.

**A re-run writes nothing.** A file already saying what Pithy would write reports `unchanged` and is never reopened, so the second run does not touch its mtime. An entry pointing somewhere else is corrected and reports `updated`. A fresh one reports `added`.

### The clients

| id | Tool | Format | Root key | Scopes |
|---|---|---|---|---|
| `claude-code` | Claude Code | JSON | `mcpServers` | project, user |
| `cursor` | Cursor | JSON | `mcpServers` | project, user |
| `vscode` | Visual Studio Code | JSONC | `servers` | project, user |
| `gemini` | Gemini CLI | JSON | `mcpServers` | project, user |
| `claude-desktop` | Claude Desktop | JSON | `mcpServers` | user |
| `cline` | Cline | JSON | `mcpServers` | user |
| `zed` | Zed | JSONC | `context_servers` | project, user |
| `codex` | Codex CLI | TOML | `mcp_servers` | project, user |
| `goose` | Goose | YAML | `extensions` | user |
| `continue` | Continue | YAML | `mcpServers` | project, user |

Four syntaxes and five root keys, spelled the way each vendor spells them: `mcp_servers` with an underscore for Codex, `context_servers` for Zed, `extensions` for Goose, which calls an MCP server an extension. The registry is `packages/cli/src/mcp/clients.ts`, one row per tool, and the eleventh tool is a row rather than a branch.

**A client is written only where it looks installed.** `--all` means every tool this machine appears to have, not every tool in the table — a Zed config on a machine with no Zed is litter. `--client <id>` writes the one you name whether or not it was detected.

**Only Claude Desktop goes through `npx -y mcp-remote`.** Its config file takes stdio servers only; its remote connectors are a UI surface, not a file one. So that row, and only that row, is written as a command rather than a URL, and `mcp-remote` runs the remote session on its behalf. Quit and reopen the app for it to load. The other nine speak streamable HTTP and are handed the address alone.

**Nothing written here carries a credential, and no code path reads one.** The server runs the standard MCP OAuth flow and registers clients dynamically, so a capable client reaches an authorized session from the URL by itself and opens a browser on first use; `mcp-remote` does the same and caches its token under your own `~/.mcp-auth`. Pithy never holds a token. That is why `@pithy-sh/secrets` is not involved and there is nothing to put in `.dev.vars`.

### A second profile

Two clients let you move their whole configuration directory with one variable, and both are followed:

| Client | Variable | User file when set | Detected by |
|---|---|---|---|
| `claude-code` | `CLAUDE_CONFIG_DIR` | `$CLAUDE_CONFIG_DIR/.claude.json` | `$CLAUDE_CONFIG_DIR` existing |
| `codex` | `CODEX_HOME` | `$CODEX_HOME/config.toml` | `$CODEX_HOME` existing |

When the variable is set and not empty, the user file and the detection path both resolve under it, so the entry lands in the profile this shell runs and `--all` finds a client that lives only there. Unset or empty, nothing changes: `~/.claude.json` and `~/.codex/config.toml`, as before. The project scope is never moved.

`--config-dir <path>` names the directory outright and wins over the variable. It is how you write a profile other than the one this shell runs, and `--print` reports the path it would take. `disconnect` and `status` resolve the same path; `status` follows the variable, since it takes no flag.

Nothing looks for other profiles. A `~/.claude-work` the variable does not name is not read, and no question is asked: the variable and the flag are the whole answer.

### Which scope

A **project** file is committed. It hands the docs to everyone who checks the repository out, and it is a change your reviewers see.

A **user** file is yours. It follows you into every project you open, and nobody else on the team gets it.

Those are different decisions with different blast radii, so the command asks rather than picking. An interactive run prints both sentences and asks *Who is this for?*; a run that cannot ask — `--json`, `--no-input`, `PITHY_NONINTERACTIVE=1`, or no terminal — is refused unless `--scope` says. The flag path holds the same line the prompt does.

A client that declares one scope takes it whatever `--scope` said. Claude Desktop, Cline and Goose have no project configuration to write, so `--scope project` against them is a question with one answer, and refusing over it would make `--all --scope project` unusable on a machine that happens to run Goose.

### `--print`

Writes nothing, anywhere. With `--client <id>` it prints the resolved path and then that client's exact snippet; with no client it prints the shape most of them take — an `mcpServers` map with a plain URL — so a tool that is not in the table is still a copy and a paste. A name the table does not know falls back to that same generic snippet rather than failing, because `--print` is the surface for tools Pithy has never heard of.

### Where else it shows up

`pithy init` offers the connection at the end of an interactive run, naming the clients it found, and says nothing at all when it found none.

`pithy doctor` reports any detected client with no entry, one line each naming the files it read, and never changes its exit code over it. It resolves them through the same code as this command, so `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move what it reads too. Whether your editor reads a documentation server is your business.

## `--json`

One line, one object. `command` names the subcommand that wrote it, and the rest of the payload follows the path taken.

**Connect** — one entry per client and scope acted on.

```
$ pithy docs connect --all --scope user --json
{"command":"docs connect","schemaVersion":1,"written":[{"client":"codex","scope":"user","path":"/home/you/.codex/config.toml","state":"added","reason":null,"snippet":null}]}
```

`written` is `[]` when no client was detected. That is exit 0 and not an error — there was nothing to write.

**Connect, refused** — the file was left alone, and the snippet to paste comes back with the reason.

```
$ pithy docs connect --client cursor --scope user --json
{"command":"docs connect","schemaVersion":1,"written":[{"client":"cursor","scope":"user","path":"/home/you/.cursor/mcp.json","state":"refused","reason":"The file is not valid JSON, so nothing was written.","snippet":"{\n  \"mcpServers\": { \"pithy\": { \"url\": \"https://pithy.sh/mcp\" } }\n}\n"}]}
```

**Connect, `--print`** — nothing was written, so there is no `written` array at all.

```
$ pithy docs connect --print --client cursor --json
{"command":"docs connect","schemaVersion":1,"printed":{"client":"cursor","path":"/home/you/.cursor/mcp.json","snippet":"{\n  \"mcpServers\": { \"pithy\": { \"url\": \"https://pithy.sh/mcp\" } }\n}\n"}}
```

**Disconnect.**

```
$ pithy docs disconnect --all --scope user --json
{"command":"docs disconnect","schemaVersion":1,"disconnected":[{"client":"cursor","scope":"user","path":"/home/you/.cursor/mcp.json","state":"removed","reason":null}]}
```

**Status** — every client in the registry, detected or not, with one record per scope it declares.

```
$ pithy docs status --json
{"command":"docs status","schemaVersion":1,"clients":[{"client":"cursor","label":"Cursor","detected":true,"scopes":[{"scope":"project","path":"/home/you/app/.cursor/mcp.json","connected":false,"url":null,"current":false},{"scope":"user","path":"/home/you/.cursor/mcp.json","connected":true,"url":"https://pithy.sh/mcp","current":true}]}]}
```

The top-level keys:

| key | type | meaning |
|---|---|---|
| `command` | string | The subcommand that wrote the line: `docs connect`, `docs disconnect` or `docs status`. On every payload |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `printed` | object | `connect --print` only. What would have been written, and where. Nothing was |
| `written` | object[] | `connect` only. One record per client and scope acted on; `[]` when nothing was detected |
| `disconnected` | object[] | `disconnect` only. One record per client and scope acted on |
| `clients` | object[] | `status` only. Every client in the registry, in the order the human report prints them |

Each record in `written`:

| field | type | meaning |
|---|---|---|
| `written[].client` | string | The client's id, as `--client` takes it |
| `written[].scope` | string | `project` or `user` — the scope actually written, which is the client's only one when it declares one |
| `written[].path` | string | The file. Absolute, because that is the spelling you can act on |
| `written[].state` | string | `added`, `updated`, `unchanged` — or `refused`, in which case no bytes changed |
| `written[].reason` | string \| null | Why it was refused, in one line. `null` otherwise, and never the file's contents |
| `written[].snippet` | string \| null | The entry to add by hand. Present on a refusal, `null` otherwise |

Each record in `disconnected` — the same shape without the snippet, since nothing needs pasting to take something out:

| field | type | meaning |
|---|---|---|
| `disconnected[].client` | string | The client's id |
| `disconnected[].scope` | string | Which configuration was read |
| `disconnected[].path` | string | The file |
| `disconnected[].state` | string | `removed`, `absent` — or `refused`, in which case no bytes changed |
| `disconnected[].reason` | string \| null | Why it was refused. `null` otherwise |

Each record in `clients`:

| field | type | meaning |
|---|---|---|
| `clients[].client` | string | The registry id |
| `clients[].label` | string | The tool's own name, as the human report prints it |
| `clients[].detected` | boolean | Whether this tool looks installed for you |
| `clients[].scopes` | object[] | One record per scope the client declares |

And each record in `clients[].scopes`:

| field | type | meaning |
|---|---|---|
| `clients[].scopes[].scope` | string | `project` or `user` |
| `clients[].scopes[].path` | string | The file this scope resolves to, whether or not it is there |
| `clients[].scopes[].connected` | boolean | Whether a `pithy` entry is in it |
| `clients[].scopes[].url` | string \| null | The address that entry names. `null` for a bridged entry, whose address is an argument, and for no entry at all |
| `clients[].scopes[].current` | boolean | Whether the entry is what this version of Pithy would write. `false` with `connected` is the stale case |

And `printed`:

| field | type | meaning |
|---|---|---|
| `printed.client` | string \| null | The client the snippet is for. `null` when no client was named, or the name was not one of these |
| `printed.path` | string \| null | Where it would go. `null` alongside a `null` client |
| `printed.snippet` | string | The snippet itself. The generic `mcpServers` shape when there is no client |

**Exit codes.** 0 when anything was written, left correct, or removed. 1 when every client asked for refused — a partial run is a run that did something, and it exits 0 with the refusals in the payload.

## Errors

**Both `--client` and `--all`.** Exit 2.

```
$ pithy docs connect --client cursor --all
Pass either --client or --all, not both.
Choose one.
```

**A client the table does not know.** Exit 2. The action lists every id.

```
$ pithy docs connect --client emacs --scope user
No client called emacs.
Pass one of: claude-code, cursor, vscode, gemini, claude-desktop, cline, zed, codex, goose, continue.
```

```
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"No client called emacs.","action":"Pass one of: claude-code, cursor, vscode, gemini, claude-desktop, cline, zed, codex, goose, continue.","exit":2,"retryable":false}}
```

**No scope, and nothing that can be asked.** Exit 2. The refusal is the point: a default here would decide on your behalf whether your team gets this too.

```
$ pithy docs connect --all --json
{"error":{"code":"input/required","status":400,"flag":"--scope","choices":["project","user"],"message":"--scope is required when nothing can be asked.","action":"Pass --scope project to commit it for the team, or --scope user for yourself.","exit":2,"retryable":false}}
```

**A scope that is not one of the two.** Exit 2.

```
$ pithy docs connect --all --scope global
--scope takes project or user, not global.
Pass --scope project to commit it for the team, or --scope user for yourself.
```

**`--config-dir` where it cannot name one profile.** Exit 2, before anything is read or written. With no `--client`, or with `--all`:

```
$ pithy docs connect --all --scope user --config-dir ~/.claude-work
--config-dir names one client's profile, so it needs --client.
Pass --client claude-code or --client codex with it, or drop --config-dir.
```

With a client whose configuration lives in one place:

```
$ pithy docs connect --client cursor --scope user --config-dir ~/.cursor-work --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"Cursor keeps its user configuration in one place, so --config-dir does not apply.","action":"Pass --client claude-code or --client codex with it, or drop --config-dir.","exit":2,"retryable":false}}
```

And without `--scope user`, since the project file is never moved:

```
$ pithy docs connect --client claude-code --scope project --config-dir ~/.claude-work
--config-dir moves the user configuration, so it needs --scope user.
Pass --scope user, or drop --config-dir.
```

**A `--config-dir` that is not a directory you have.** Exit 2. A leading `~` the shell did not expand:

```
$ pithy docs connect --client claude-code --scope user --config-dir=~/.claude-work
--config-dir ~/.claude-work starts with ~, which the shell did not expand.
Pass the full path, or $HOME in place of the ~.
```

A directory that is not there:

```
$ pithy docs connect --client claude-code --scope user --config-dir /home/you/.claude-wrok
There is no directory at /home/you/.claude-wrok.
Name the profile's directory as it is: Claude Code creates it the first time it runs with that profile.
```

**No target, unattended.** A bare `pithy docs connect` at a terminal acts on every detected client. Without one there is nothing to prompt with, so it names the flags instead. Exit 2.

```
$ pithy docs connect --json
{"error":{"code":"input/required","status":400,"flag":"--client","choices":["claude-code","cursor","vscode","gemini","claude-desktop","cline","zed","codex","goose","continue"],"message":"Name what to connect.","action":"Pass --client <id> for one, or --all for every client detected here.","exit":2,"retryable":false}}
```

**A file that will not parse** is not one of these. It is a `refused` row, per client, and the run carries on to the rest. Exit 1 only if every client asked for refused.

## Examples

Connect everything on this machine, for yourself.

```
$ pithy docs connect --all --scope user
Cursor     added  /home/you/.cursor/mcp.json
Codex CLI  added  /home/you/.codex/config.toml
Done.
```

Run it again.

```
$ pithy docs connect --all --scope user
Cursor     unchanged  /home/you/.cursor/mcp.json
Codex CLI  unchanged  /home/you/.codex/config.toml
Done.
```

Commit it for the team.

```
$ pithy docs connect --client cursor --scope project
Cursor  added  /home/you/app/.cursor/mcp.json
Done.
```

An entry that pointed somewhere else.

```
$ pithy docs connect --client cursor --scope user
Cursor  updated  /home/you/.cursor/mcp.json
Done.
```

A file Pithy will not rewrite. Nothing was written, the snippet is printed, and there is no `Done.` — that word is a claim that something was done.

```
$ pithy docs connect --client cursor --scope user
Cursor  refused  /home/you/.cursor/mcp.json — The file is not valid JSON, so nothing was written.

Add this to /home/you/.cursor/mcp.json yourself:
{
  "mcpServers": { "pithy": { "url": "https://pithy.sh/mcp" } }
}
```

A machine running none of these.

```
$ pithy docs connect --all --scope user
No AI clients detected here.
Run `pithy docs connect --print` for the snippet to add by hand.
```

The snippet for a tool that is not in the table.

```
$ pithy docs connect --print
No client named, so this is the shape most of them take.
{
  "mcpServers": {
    "pithy": {
      "type": "http",
      "url": "https://pithy.sh/mcp"
    }
  }
}
```

One client's own shape, and where it goes.

```
$ pithy docs connect --print --client codex
/home/you/app/.codex/config.toml:
[mcp_servers.pithy]
url = "https://pithy.sh/mcp"
```

A second Claude Code profile, followed through the variable.

```
$ CLAUDE_CONFIG_DIR=~/.claude-work pithy docs connect --client claude-code --scope user
Claude Code  added  /home/you/.claude-work/.claude.json
Done.
```

The same profile, named from a shell running another.

```
$ pithy docs connect --client claude-code --scope user --config-dir ~/.claude-work
Claude Code  unchanged  /home/you/.claude-work/.claude.json
Done.
```

Where everything stands.

```
$ pithy docs status
Claude Code         not connected
Cursor              connected: project, user
Visual Studio Code  not detected
Gemini CLI          not detected
Claude Desktop      not detected
Cline               not detected
Zed                 not detected
Codex CLI           connected: user (stale)
Goose               not detected
Continue            not detected
```

`(stale)` means there is a `pithy` entry there and it is not what this version would write. `pithy docs connect` corrects it.

Take it back out.

```
$ pithy docs disconnect --all --scope user
Cursor     removed  /home/you/.cursor/mcp.json
Codex CLI  removed  /home/you/.codex/config.toml
Done.
```

```
$ pithy docs disconnect --all --scope user
Cursor     absent  /home/you/.cursor/mcp.json
Codex CLI  absent  /home/you/.codex/config.toml
Done.
```
