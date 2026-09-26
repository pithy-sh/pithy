---
"@pithy-sh/cli": minor
---

`pithy docs connect` wires the Pithy documentation server into your AI coding agent. Ten clients, three config formats, one command.

Getting an agent onto `pithy.sh/mcp` was ten different manual steps. Claude Code reads `.mcp.json`, Cursor reads `.cursor/mcp.json`, VS Code keys its servers under `servers` rather than `mcpServers`, Zed calls them `context_servers`, Codex wants TOML, Goose and Continue want YAML, and Claude Desktop's path depends on the operating system. The adopter had to know which file, in which place, in which format, under which key, for the tool they happen to run.

`pithy docs connect` detects what is installed and writes the entry. `pithy docs disconnect` takes it back out. `pithy docs status` says which clients are wired and where. All three are flag-driven, `--json`-capable and idempotent — a second run reports `unchanged` and writes no bytes.

**Everything that differs between clients is a row in one table**, so the eleventh tool is a row and not a branch: the detection path, the project and user files per operating system, the format, the root key, the entry shape, and whether the client runs MCP OAuth itself. Nine of them do, and are handed the URL alone. Claude Desktop's config file takes stdio servers only, so that row — and only that row — is written through `npx -y mcp-remote`, which runs the same flow. The registry is the one place that distinction is recorded.

**It merges, and it refuses on doubt.** Each writer sets one key under one root key and leaves every other byte alone: your Playwright server, your Linear server, your comments, and in `~/.claude.json` the session state Claude Code keeps beside its servers. A document Pithy cannot read with confidence is never rewritten — the command names the file, prints the snippet to add by hand, and says nothing was written. An entry pointing somewhere else is corrected, and the run says `updated` rather than `added`.

**Scope is asked, never assumed.** A project file is committed and gives the docs to everyone on the repository; a user file follows you into every project you open. An interactive run asks; a run with nobody to ask is refused unless `--scope` says which. A client with only one configuration takes it either way.

`--print` emits the snippet for any client without touching the filesystem, including one not in the table, so an unrecognized tool is a copy-paste rather than a dead end.

`pithy init` offers the connection after scaffolding when clients are detected, and `pithy doctor` lists any detected client that cannot read the docs, with the command that connects each.

Nothing written carries a credential and no code path reads one. The server runs OAuth 2.1 with dynamic client registration, so the flow belongs to the client or to `mcp-remote`, which caches its own token under `~/.mcp-auth`.
