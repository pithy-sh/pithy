# pithy contract

_The site renders this for readers: [pithy.sh/docs/cli/commands/contract](https://pithy.sh/docs/cli/commands/contract). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Write each Worker's OpenAPI document: every route it serves, with its parameters, body, responses and how a caller is verified, read off the app the Worker composes. A Worker that serves a socket gets an AsyncAPI document beside it.

## Synopsis

```bash
pithy contract [--worker <name>] [--out <dir>] [--env <name>] [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--worker <name>` | Only this Worker, by the name `pithy worker list` shows or its `apps/<dir>` basename. Default: every Worker. |
| `--out <dir>` | Write each document as `<dir>/<worker>/openapi.json`, and `<dir>/<worker>/asyncapi.json` for a Worker that serves a socket. Default: `apps/<worker>/`, beside the Worker it describes. |
| `--env <name>` | The environment each Worker is composed for. Default `prod`. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

A client that is not TypeScript has nothing to import from the kit. It has this. Every language has an OpenAPI generator, so a Swift, Kotlin or C# client generates its calls from the document rather than writing each one by hand.

`pithy contract` loads each Worker's `pithy.config.ts` for one environment, assembles its app exactly as the Worker does at startup, and walks the route table. Nothing in the document is written by hand:

- **What a route accepts** comes from its `validate(target, Schema)` middleware: path, query, header and cookie parameters, and the JSON or form body.
- **What it is for, how its caller is verified, and what it returns** come from its `describeRoute({ summary, verification, responses })` middleware.
- **Every field's description** comes from the Zod schema's `.describe()`, so a generated client carries the same documentation as the TypeScript one.
- **Every error** is the one `{ error: { code, status, message } }` body, described once and referenced by every operation.

Every route the kit provides is described. Your own routes are described as far as you describe them. A route with a `describeRoute` is written in full. A route without one is still written, from its `validate` schemas alone, and marked `x-pithy-undescribed: true`, so a generated client still reaches it and the mark tells you which routes to finish. The command lists them.

**One environment per document**, because the route table is one per environment: `@pithy-sh/auth` mounts its dev sign-in in `dev` and nowhere else. `prod` is the default because it is the table a shipped client calls.

The document states OpenAPI 3.1. Its `info.version` is your root `package.json` version, or `0.0.0` without one. Each operation carries `x-pithy-verification`, the route's verification strategies, and `x-pithy-scopes` when it needs a scope beyond being verified.

It writes only when the bytes changed, so a second run is a no-op and the file is safe to commit and to check in CI.

**It is generated, so your formatter leaves it alone.** A project scaffolded by `pithy init` excludes `**/openapi.json` and `**/asyncapi.json` in `biome.jsonc`. A project scaffolded before then adds `"!**/openapi.json"` and `"!**/asyncapi.json"` to `files.includes` itself; otherwise `biome check` reformats a document and the next `pithy contract` writes it back.

**A Worker that serves a socket gets `asyncapi.json` beside it.** OpenAPI stops at the upgrade; after it there are only frames. A capability that serves a socket — `@pithy-sh/multiplayer`'s rooms, `@pithy-sh/matchmaking`'s presence — declares it, and the AsyncAPI 3.0 document describes each one: its path, how the upgrade is verified, the subprotocol versions it serves, and a schema for every frame each side sends, with every field described. A game's own `action` and `view` schemas are in it too, so a client in any engine types the part that is the game. How those frames may change from one release to the next is [`docs/SOCKETS.md`](../SOCKETS.md). A Worker that serves no socket gets no `asyncapi.json`, and `asyncapi` is `null`. One that stopped serving a socket loses the `asyncapi.json` this command wrote for it; a file it did not write is left alone.

`pithy schema` describes the CLI and reads nothing from your project. This command reads your project. That is why they are two commands.

## `--json`

One line on stdout.

| key | type | meaning |
|---|---|---|
| `command` | string | `"contract"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `environment` | string | The environment every Worker was composed for. |
| `workers` | object[] | One entry per selected Worker, in `apps/` order. |
| `workers[].worker` | string | The Worker's `apps/` directory. |
| `workers[].path` | string | Where its document was written, relative to the project root. |
| `workers[].operations` | integer | How many operations the document holds, one per method and path. |
| `workers[].undescribed` | object[] | Routes written from their validators alone and marked `x-pithy-undescribed`. Empty when every route is described. |
| `workers[].undescribed[].method` | string | The HTTP method, as Hono records it. |
| `workers[].undescribed[].path` | string | The route's path pattern. |
| `workers[].changed` | boolean | Whether the file's contents changed. `false` when it already matched. |
| `workers[].asyncapi` | object \| null | Its AsyncAPI document, for the sockets it serves, or `null` for a Worker that serves none. |
| `workers[].asyncapi.path` | string | Where its AsyncAPI document was written, relative to the project root. |
| `workers[].asyncapi.channels` | integer | How many sockets the document describes. |
| `workers[].asyncapi.changed` | boolean | Whether the file's contents changed. `false` when it already matched. |

## Errors

- **An environment that is not one.** `--env production` is refused with `prod` named, before anything is composed.
- **``pithy.config.ts has no `name`.``** Every document is titled with the project's name, so the root config must declare one.
- **`No workers here.`** Nothing under `apps/` is a Worker. Create one with `pithy worker add`.
- **`No worker named "<name>".`** `--worker` matched nothing. The refusal lists the Workers that exist.
- **A config that will not load.** The Worker's `pithy.config.ts` threw while it was evaluated. The refusal names the Worker and the error.

## Examples

```bash
pithy contract
pithy contract --worker api --out contracts
pithy contract --env staging --json
```

Then generate a client in any language. For example, with the OpenAPI Generator:

```bash
openapi-generator-cli generate -i apps/api/openapi.json -g swift5 -o ios/PithyClient
```
