# pithy schema

_The site renders this for readers: [pithy.sh/docs/cli/commands/schema](https://pithy.sh/docs/cli/commands/schema). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Describe every command, flag, payload and error code, as JSON, from the binary that is installed.

## Synopsis

```bash
pithy schema [command…] [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `[command…]` (positional, optional) | Describe only this command and those beneath it. Any number of words: `pithy schema token mint`. Omitted, the whole tree. |
| `--json` | Machine-readable output. Default `false`. The answer is JSON either way; see below. |

## What it does

`pithy schema` is the CLI describing itself, so an agent can build a call without reading a page or guessing at a flag. It is served from the binary, which is the point: the answer is true of the version installed on this machine and of no other. `docs/catalog.generated.json` says what the repository's `main` holds; this says what `pithy` here will accept.

**Without a command it answers for the whole tree.** Every command, groups included, sorted by path; the flags every command takes; the environment variables the CLI reads; the exit codes; and every error code the kit defines, each with its exit class and what to do about it. **With a command it answers for that command and everything beneath it**, so `pithy schema token` is the group and its four subcommands, and `pithy schema token mint` is the one.

Each command says two things. **What it parses**, read off the parser itself: its positionals, in order, with `required` worked out the way the parser refuses a call — a positional with no default is required unless it says otherwise — and its flags, each with its type, whether it is required, its default, the fixed set of values it takes where there is one, whether it repeats, and its description. A boolean with no default has none published, because leaving it off is its own state, not `false`. Every other spelling the parser answers to is listed under the canonical name and marked by how it arises: `camelCase` (`--workerUrl` reaches `--worker-url`), `declared` (`-n` reaches `--lines`), or `negation` (`--no-json` sets `--json` to false). **And what it promises**: how it answers `--json` — one `document`, a `stream` of records, or `none` — the JSON Schema of that payload, the error line it writes on failure, whether a successful run can change anything (`mutates`), whether running it again with the same arguments succeeds and changes nothing further (`idempotent`), whether it can reach the network (`needsNetwork`), and the rules over several flags the parser cannot express, such as `provision`'s `--env` or `--feature`, exactly one.

**`mutates` and `idempotent` describe the default run**: the command with its required arguments and no optional flag. A flag that changes the answer says so in its own description — `--dry-run` and `ui sync --check` make a write read nothing, and `doctor --disable-notifier` makes a read persist a preference — because a flag counted against every command would publish `true` nearly everywhere and tell a caller nothing. The CLI's own update-notifier cache, which any command may refresh, is not a change to anything you own, so `pithy doctor` is `mutates: false`. **A second run that is refused is not idempotent**, however clean the refusal: `ui add` refuses a Worker that already has its front end, and `testers invite` an address already on the roster, so both are `false`. `packages/cli/src/contract/idempotent.test.ts` runs every command it can drive offline twice and holds the flag to what the second run did.

**Every payload schema is a Zod schema in the command's own module**, and a test parses each command's real `--json` output against the one published here, so the two cannot drift. The JSON Schemas are the side a parse accepts: every object is open, because adding a key to a payload is not a breaking change and a published `additionalProperties: false` would make it one for every consumer that validates with it. **Some nested objects are published with no fields named yet**, and these are a known gap rather than a promise: most of `pithy doctor`'s per-check detail, the parts of the testers cohort view, `pithy seed`'s per-store writes, `pithy secrets verify`'s sweep and what `pithy upgrade --packages` moved. Each says what it is in its `description` and nothing about its keys, and the real-output test checks only the keys around it. A test lists every one, so the list can only shrink.

**The error line is published once.** It is the same for every command and about 160 KB, so each command's `errorLine` is `{"$ref": "#/errorLine"}`, a pointer at the document's own `errorLine`.

**The answer is JSON with or without `--json`.** It is a document for a program to read, and a shorter human rendering would be `--help` again. Without `--json` the line is formatted for whoever is reading, exactly as a `--json` line is: indented at a terminal, compact in a pipe, and `PITHY_JSON` settles it for a session.

It reads nothing from the project and writes nothing anywhere, so it runs the same inside a project, outside one, and offline.

## `--json`

One line on stdout. The whole tree:

| key | type | meaning |
|---|---|---|
| `command` | `"schema"` | The command that produced the line. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `version` | string | The installed CLI's version. Everything in the document describes this version. |
| `commands` | object[] | Every command in the tree, groups included, sorted by path. |
| `globalFlags` | object[] | The flags every command takes, answered before any command runs. |
| `environmentVariables` | object[] | Every environment variable the CLI reads. |
| `exitCodes` | object[] | Every exit code the CLI uses on purpose, in order. |
| `errorCodes` | object[] | Every error code the kit defines, sorted by code. |
| `errorLine` | object | The JSON Schema of the `{ "error": … }` line a failed run writes to stderr. |

With a command, `globalFlags`, `environmentVariables`, `exitCodes` and `errorCodes` are left out, and one key is added:

| key | type | meaning |
|---|---|---|
| `path` | string | The command asked about, as typed after `pithy schema`. `commands` holds it first, then everything beneath it. |

Each entry of `commands`:

| field | type | meaning |
|---|---|---|
| `commands[].path` | string | The command as typed after `pithy`: `add`, `token mint`. |
| `commands[].description` | string | What it does, as `--help` says it. |
| `commands[].aliases` | string[] | Other names the command answers to. Empty for every command today. |
| `commands[].subcommands` | string[] | The paths of the commands beneath it. |
| `commands[].runs` | boolean | Whether it acts on its own. `false` for a group, which only prints its subcommands. |
| `commands[].positionals` | object[] | `name`, `required`, `variadic`, `default` when it has one, `enum` when the values it takes are fixed (`pithy add`'s capability), and `description`, in the order the command reads them. `variadic` is `true` for a positional that takes every remaining word rather than one — `pithy schema`'s own `command` is the one today — and only a command's last positional can be. `--help` prints it `[COMMAND…]`, the way each page's synopsis writes it. |
| `commands[].flags` | object[] | `name`, `type` (`boolean` or `string`), `required`, `default`, `enum`, `repeatable`, `description`, `negativeDescription`, and `aliases` — each `{ flag, kind }`. |
| `commands[].flagGroups` | object[] | Rules over several flags. `kind` is `exactlyOne`, `atMostOne` or `allOrNone` with `flags`, or `requires` with `flag`, `needs` and `any` — whether any one of `needs` is enough. Each carries its `rule` in a sentence. |
| `commands[].output` | string | `document`, `stream`, or `none`. |
| `commands[].payload` | object \| null | The JSON Schema of its `--json` output: the one document, or any one record of a stream. `null` when `output` is `none`. It names `schemaVersion` as a constant, so a validator refuses a line at another version. |
| `commands[].schemaVersion` | integer \| null | The version every `--json` line the command writes carries as `schemaVersion`. Bumped only when a key is removed or retyped (`docs/CLI.md` §1.2). `null` when `output` is `none`. |
| `commands[].events` | object \| null | The JSON Schema of one `--json --events` progress record, at the same version. `null` for every command but `deploy` and `provision`, the two that take `--events`. |
| `commands[].errorLine` | object | `{"$ref": "#/errorLine"}`. |
| `commands[].mutates` | boolean | Whether a successful run can change anything: files, Cloudflare, a database, a store. It describes the default run, with no optional flag. |
| `commands[].idempotent` | boolean | Whether running it again with the same arguments, after it succeeded, succeeds and changes nothing further. A second run that is refused is not idempotent. |
| `commands[].needsNetwork` | boolean | Whether it can reach the network: Cloudflare, npm, a browser flow. |

Each entry of `globalFlags` is `name`, `aliases`, `description` and `hidden` — `--pithier` and `--pithiest` are left out of `--help`, not out of this. Each entry of `environmentVariables` is `name`, `values` — what it takes, in words — and `description`. Each entry of `exitCodes` is `exit`, `exitClass` (`null` for 0, 130 and 141), `meaning`, `agentShould` and `retryable`, the table in [`docs/CLI.md`](../CLI.md) §3.8. Each entry of `errorCodes` is `code`, `status`, `exitClass`, `exit`, `retryable` and `remedy`, the same rows `docs/catalog.generated.json` carries.

## Errors

The command exits 0 whenever it can describe what was asked, which is always but once:

- **`No command \`pithy <words>\`.`** The words name no command. The action line names what the deepest command they do reach has beneath it — `` `pithy token` has list, mint, revoke, rotate. `` — or the top-level commands, when even the first word is not one. When that command is a leaf, the words past it are a value rather than a command, and the action line says so and points at its own schema: `` `pithy add` takes no subcommand; its arguments are in `pithy schema add --json`. `` `validation/invalid_input`, exit 2.

An undeclared flag is refused as it is everywhere, exit 2 (`docs/CLI.md` §1.2).

## Examples

```bash
# Everything the installed CLI has.
pithy schema --json

# One command: its flags, its groups, the JSON Schema of what it writes.
pithy schema provision --json

# A group and everything beneath it.
pithy schema token --json

# What --worker-url is called by every other name, with jq.
pithy schema dashboard connect --json | jq '.commands[0].flags[] | select(.name == "--worker-url")'
```

```json
{"command":"schema","schemaVersion":1,"version":"0.13.1","path":"token mint","commands":[{"path":"token mint","description":"Mint a profile's scoped account token, or roll an existing one's value (rotate re-scopes)","aliases":[],"subcommands":[],"runs":true,"positionals":[{"name":"profile","required":true,"variadic":false,"description":"Token profile: ci-system (the CI credential), or a capability's worker-consumer profile"}],"flags":[{"name":"--env","type":"string","required":false,"default":"dev","repeatable":false,"description":"Target environment: dev, staging, prod, or one declared in pithy.config.ts","aliases":[]},…],"flagGroups":[],"output":"document","payload":{…},"schemaVersion":1,"events":null,"errorLine":{"$ref":"#/errorLine"},"mutates":true,"idempotent":false,"needsNetwork":true}],"errorLine":{…}}
```

Nothing it prints is a credential. It reads no configuration and no environment beyond the CLI's own code.
