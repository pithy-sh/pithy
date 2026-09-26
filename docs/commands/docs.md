# pithy docs

_The site renders this for readers: [pithy.sh/docs/cli/commands/docs](https://pithy.sh/docs/cli/commands/docs). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Point your AI coding agent at the Pithy documentation server.

## Synopsis

```
pithy docs connect [--client <id> | --all] [--scope <project|user>] [--json]
pithy docs connect --print [--client <id>] [--scope <project|user>] [--json]
pithy docs disconnect [--client <id> | --all] [--scope <project|user>] [--json]
pithy docs status [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--client <id>` | string | — | One client, by the id in the table below |
| `--all` | boolean | `false` | Every client detected on this machine |
| `--scope <project\|user>` | string | — | `project` writes the repository's file; `user` writes your own |
| `--print` | boolean | `false` | `connect` only. Print the snippet and write nothing |
| `--json` | boolean | `false` | Machine-readable output |

`--client` and `--all` are mutually exclusive. `--scope` is required whenever nothing can be asked — a run under `--json`, or with no terminal attached.

`disconnect` takes the same target flags without `--print`. `status` takes `--json` and nothing else: it reads.

## What it does

The server is [`https://pithy.sh/mcp`](https://pithy.sh/mcp). It answers questions about Pithy — the capabilities, the config surface, the naming rules, this reference — so an agent working in your repository reads the current documentation instead of guessing from its training data.

Every client in the table below can be pointed at it. They disagree on the file, the syntax, the key and the spelling of the address, and none of that is your problem: `pithy docs connect` writes each one in its own vocabulary.

**One key, merged in.** The entry is written under the name `pithy`, and that is the only name this command sets and the only name `disconnect` removes. Everything else in the file — your own MCP servers, an editor's settings, Claude Code's session state — is read, kept, and written back unchanged. This is not a manager for your other servers, and each refusal below exists to keep that true.

**Nothing is guessed at.** A document that will not parse is left byte-identical on disk, the row says `refused` with the reason, and the snippet to paste is printed under it. A best-effort write into a half-written `~/.claude.json` is a tool that stops working tomorrow with no way back to today.

**A project file stays inside the project.** A project path is composed from a root you did not write — a repository you cloned — so every segment of it is somebody else's content. If `.zed`, or `.continue/mcpServers`, or the config file itself turns out to be a symlink, the write is refused and named rather than followed. A repository could otherwise ship `.cursor/mcp.json` as a link to anywhere you can write, and the first `--scope project` run would create or overwrite that file instead. User paths are not held to this: `$HOME` is yours, and so is every link in it.

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

### Which scope

A **project** file is committed. It hands the docs to everyone who checks the repository out, and it is a change your reviewers see.

A **user** file is yours. It follows you into every project you open, and nobody else on the team gets it.

Those are different decisions with different blast radii, so the command asks rather than picking. An interactive run prints both sentences and asks *Who is this for?*; a run that cannot ask — `--json`, or no terminal — is refused unless `--scope` says. The flag path holds the same line the prompt does.

A client that declares one scope takes it whatever `--scope` said. Claude Desktop, Cline and Goose have no project configuration to write, so `--scope project` against them is a question with one answer, and refusing over it would make `--all --scope project` unusable on a machine that happens to run Goose.

### `--print`

Writes nothing, anywhere. With `--client <id>` it prints the resolved path and then that client's exact snippet; with no client it prints the shape most of them take — an `mcpServers` map with a plain URL — so a tool that is not in the table is still a copy and a paste. A name the table does not know falls back to that same generic snippet rather than failing, because `--print` is the surface for tools Pithy has never heard of.

### Where else it shows up

`pithy init` offers the connection at the end of an interactive run, naming the clients it found, and says nothing at all when it found none.

`pithy doctor` reports any detected client with no entry, one line each, and never changes its exit code over it. Whether your editor reads a documentation server is your business.

## `--json`

One line, one object. `command` names the subcommand that wrote it, and the rest of the payload follows the path taken.

**Connect** — one entry per client and scope acted on.

```
$ pithy docs connect --all --scope user --json
{"command":"docs connect","written":[{"client":"codex","scope":"user","path":"/home/you/.codex/config.toml","state":"added","reason":null,"snippet":null}]}
```

`written` is `[]` when no client was detected. That is exit 0 and not an error — there was nothing to write.

**Connect, refused** — the file was left alone, and the snippet to paste comes back with the reason.

```
$ pithy docs connect --client cursor --scope user --json
{"command":"docs connect","written":[{"client":"cursor","scope":"user","path":"/home/you/.cursor/mcp.json","state":"refused","reason":"The file is not valid JSON, so nothing was written.","snippet":"{\n  \"mcpServers\": { \"pithy\": { \"url\": \"https://pithy.sh/mcp\" } }\n}\n"}]}
```

**Connect, `--print`** — nothing was written, so there is no `written` array at all.

```
$ pithy docs connect --print --client cursor --json
{"command":"docs connect","printed":{"client":"cursor","path":"/home/you/.cursor/mcp.json","snippet":"{\n  \"mcpServers\": { \"pithy\": { \"url\": \"https://pithy.sh/mcp\" } }\n}\n"}}
```

**Disconnect.**

```
$ pithy docs disconnect --all --scope user --json
{"command":"docs disconnect","disconnected":[{"client":"cursor","scope":"user","path":"/home/you/.cursor/mcp.json","state":"removed","reason":null}]}
```

**Status** — every client in the registry, detected or not, with one record per scope it declares.

```
$ pithy docs status --json
{"command":"docs status","clients":[{"client":"cursor","label":"Cursor","detected":true,"scopes":[{"scope":"project","path":"/home/you/app/.cursor/mcp.json","connected":false,"url":null,"current":false},{"scope":"user","path":"/home/you/.cursor/mcp.json","connected":true,"url":"https://pithy.sh/mcp","current":true}]}]}
```

The top-level keys:

| key | type | meaning |
|---|---|---|
| `command` | string | The subcommand that wrote the line: `docs connect`, `docs disconnect` or `docs status`. On every payload |
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

**Both `--client` and `--all`.** Exit 1.

```
$ pithy docs connect --client cursor --all
Pass either --client or --all, not both.
Choose one.
```

**A client the table does not know.** Exit 1. The action lists every id.

```
$ pithy docs connect --client emacs --scope user
No client called emacs.
Pass one of: claude-code, cursor, vscode, gemini, claude-desktop, cline, zed, codex, goose, continue.
```

```
{"error":{"code":"core/not_found","status":404,"message":"No client called emacs.","action":"Pass one of: claude-code, cursor, vscode, gemini, claude-desktop, cline, zed, codex, goose, continue."}}
```

**No scope, and nothing that can be asked.** Exit 1. The refusal is the point: a default here would decide on your behalf whether your team gets this too.

```
$ pithy docs connect --all --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"--scope is required when nothing can be asked.","action":"Pass --scope project to commit it for the team, or --scope user for yourself."}}
```

**A scope that is not one of the two.** Exit 1.

```
$ pithy docs connect --all --scope global
--scope takes project or user, not global.
Pass --scope project to commit it for the team, or --scope user for yourself.
```

**No target, unattended.** A bare `pithy docs connect` at a terminal acts on every detected client. Without one there is nothing to prompt with, so it names the flags instead. Exit 1.

```
$ pithy docs connect --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"Name what to connect.","action":"Pass --client <id> for one, or --all for every client detected here."}}
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
