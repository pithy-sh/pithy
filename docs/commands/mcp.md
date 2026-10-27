# pithy mcp

_The site renders this for readers: [pithy.sh/docs/cli/commands/mcp](https://pithy.sh/docs/cli/commands/mcp). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Let an AI agent administer your application through the same scoped, audited control-plane seam the dashboard uses.

## Synopsis

```
pithy mcp connect --env <env> --purpose <text> [--scope <scope>]... [--client <id> | --all] [--json]
pithy mcp connect --env <env> --purpose <text> --oidc-issuer <iss> --oidc-claim <name=value>... [--oidc-audience <aud>] [--oidc-token <source>] [--client <id> | --all] [--json]
pithy mcp connect --env <env> --update --scope <scope>... [--json]
pithy mcp serve --connection <alias>
pithy mcp status [--json]
pithy mcp disconnect --connection <alias> [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--env <env>` | string | `dev` | `connect` only. The environment the agent administers |
| `--worker <name>` | string | — | `connect` and `disconnect`. Which worker composes the admin surface (`apps/<name>`) |
| `--worker-url <url>` | string | — | `connect` only. Override the resolved worker URL |
| `--purpose <text>` | string | — | `connect` only. What the agent is for, in one line. Required to register |
| `--scope <scope>` | string, repeatable | derived | `connect` only. Grant one scope; `--scope all` grants every composed scope. With `--update`, the whole grant |
| `--update` | boolean | `false` | `connect` only. Replace the connection's grant with exactly the `--scope` values given |
| `--oidc-issuer <iss>` | string | — | `connect` only. Register a workload trust instead of a key |
| `--oidc-claim <name=value>` | string, repeatable | — | With `--oidc-issuer`. A claim the job's token must carry. At least one |
| `--oidc-audience <aud>` | string | the worker's origin | With `--oidc-issuer`. The `aud` its tokens must name |
| `--oidc-token <source>` | string | `github` for GitHub | With `--oidc-issuer`. `github`, `gitlab:<VARIABLE>` or `env:<VARIABLE>` |
| `--client <id>` | string | — | `connect` only. Write the entry into one client, by the id `pithy docs` uses |
| `--all` | boolean | `false` | `connect` only. Write the entry into every client detected here |
| `--connection <alias>` | string | — | `serve` and `disconnect`. The connection, `pithy-<project>-<env>` for a key, `pithy-<project>-<env>-ci` for a trust |
| `--json` | boolean | `false` | Machine-readable output. `serve` has none: its stdout is the protocol |

`--client` and `--all` are mutually exclusive. `--oidc-claim`, `--oidc-audience` and `--oidc-token` apply only with `--oidc-issuer`, and `--oidc-issuer` is refused beside `--update`. Each is a usage error, exit 2.

## What it does

`pithy mcp serve` is a stdio MCP server shipped with the CLI. An MCP client spawns it, and its tools are your Worker's own admin routes, read from `GET /control-plane/manifest` every time the client lists them. A call to a tool is a control-plane call: it names that route's one scope, presents this connection's credential, and is verified, refused or allowed, and audited by your Worker exactly as any other call is, with actor kind `agent`. Nothing is hosted, by us or by anyone. [`AGENT-ACCESS.md` §3](../AGENT-ACCESS.md) says why it is not a capability.

**Offered only when it can be called.** A tool is offered when your Worker composes the capability, declares the route, and granted this connection its scope. Anything else is absent, not offered and refused, and learning that costs one manifest read: no call to the route and no credential minted for its scope. A route from a Worker that predates `operation` and `input` is not offered either, rather than offered under a guessed name.

**Tool names are permanent.** A tool is `<capability>_<operation>`: `support_threads_reply`, `auth_users_suspend`. The operation is declared by the capability beside the route, never derived from the path, and `.`, `:` and `/` become `_` in one place. Its input schema is the route's own path, query and body validators, generated rather than written twice, under `path`, `query` and `body`.

**One server entry per connection.** Environments run different versions, so a tool can take a different input on staging than on production. Each environment is its own entry, `pithy-acme-prod` and `pithy-acme-staging`, serving exactly what its Worker declares. The client namespaces the servers; the tool names stay the same. A trust's entry is `pithy-acme-prod-ci`: a developer's key and CI's trust on one environment share its connection but never an alias, because the key's record is yours and the trust's is committed, and one name in both would leave your own server refused in that checkout.

**The client configuration names the connection, never the credential.** Every entry runs `pithy mcp serve --connection <alias>`, and the server reads the key file or fetches the token itself. `pithy` must be on the client's `PATH`. The entry is written the way `pithy docs connect` writes its own: merged under one key, a file it cannot parse refused with the reason, a symlinked project path refused.

### A key, on your machine

`pithy mcp connect --env prod --purpose "..."` generates the agent's own Ed25519 keypair and registers the public half through the path `pithy dashboard connect --public-key` uses: kind `agent`, your purpose, and the signed-in session's principal. Without a session it is refused before anything is written, naming `pithy cloudflare connect`. The grant is chosen the way `pithy dashboard connect` chooses one: asked at a terminal, `--scope` when nothing can ask, `--scope all` for every composed scope. Include `manifest:read`: the server reads the manifest under it on every tool list, and calls `ping` under it, so without it the server offers no tools and every list fails.

The private half is written to `<config>/keys/<connectionId>.jwk`, mode `0600`, in a `0700` directory, and nowhere else. No keychain: one behavior on every host, with the custody of an SSH key. `serve` refuses a key file another user owns, or one whose mode lets anybody else read it, and names the fix:

```
✗ The agent key cannot be trusted: /home/you/.config/pithy/keys/5f0c….jwk is mode 0644, readable by others.
  Run chmod 600 /home/you/.config/pithy/keys/5f0c….jwk, then start the server again.
```

The connection's record goes to `<config>/mcp-connections.json`, and its client entry to your user-scope configuration, because the key is this machine's. The connection's environment must have no live key already; a dashboard connected to it is one, and is refused as `--public-key` refuses it. A key may join a connection the environment already has only when that connection is an agent's, such as CI's trust: it then takes that connection's grant, so nothing is asked and a `--scope` is refused, naming `--update`. On a connection that is a script's or the dashboard's it is refused, so its calls are never audited as that client's or relabelled `agent`.

### A workload trust, in CI

With `--oidc-issuer` and at least one `--oidc-claim`, `connect` registers an OIDC trust through the path `pithy dashboard connect --oidc-issuer` uses, and writes no key. At spawn the server fetches a workload token for the environment's own origin and presents it on every call beside the trust it claims and the scope it exercises, fetching again a minute before it expires. The token is held in memory and never written.

| `--oidc-token` | Where the token comes from |
|---|---|
| `github` | GitHub Actions: requested from the runner's `ACTIONS_ID_TOKEN_REQUEST_URL` with `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. The workflow needs `permissions: id-token: write` |
| `gitlab:<VARIABLE>` | GitLab CI: the variable the job's `id_tokens:` block names, with `aud:` set to the environment's origin |
| `env:<VARIABLE>` | Any other issuer: the variable the job exports the token in |

GitHub's issuer takes `github` without asking; every other issuer needs `--oidc-token`. A trust may join a connection the environment already has only when that connection is an agent's: it then takes that connection's grant and purpose, so nothing is asked and a `--scope` is refused. The Worker audits a call with its connection's kind, so a trust is refused on an environment connected to the dashboard or a script rather than audited as one. The record is committed with the project at `.pithy/mcp.jsonc`, because CI starts from a checkout, and the client entry goes into the project-scope configuration. A client with no project configuration is refused for a trust, and said so. Nothing proves a trust until a job calls, so the status is `awaiting_first_call`.

### Changing the grant

`pithy mcp connect --env prod --update --scope support:threads:read --scope manifest:read` replaces the connection's grant with exactly the scopes given, as `pithy dashboard connect --update` does, and records `controlplane/connection_updated`. It is refused without a session, like a registration. The grant belongs to the connection, so every credential on it shares the change. It is refused when your Worker's connection is no longer the one the record names, as after `pithy dashboard disconnect` and a later `dashboard connect`: that grant is another client's, and the refusal names `pithy mcp disconnect`.

### Disconnecting

`pithy mcp disconnect --connection pithy-acme-prod` revokes the key or the trust on your Worker first, then removes the key file, the client entries and the record. A token already minted under a trust stays usable until it expires, and the report says so. Run it again and it finds nothing, which is not an error. A connection already removed from your Worker, by `pithy dashboard disconnect` or a reset database, has nothing left to revoke, and the rest is still cleaned up; so does one replaced since by another client's, where nothing is revoked. Run it in the project the connection belongs to: the registry it revokes on is the one in the directory you run it from, so a connection of another project's is refused, naming that project.

**Records are read from where they belong, or not at all.** A key connection is read only from `<config>/mcp-connections.json`, and only for a key file at `<config>/keys/<connectionId>.jwk`; a trust connection only from `.pithy/mcp.jsonc`. An alias recorded in both is refused. A key's client entry is live in every project you open, and the project's file arrives with whatever you clone, so a checkout cannot point your entry at another Worker, another variable or another key file. Each refusal names the file to fix.

## `--json`

Every line names what wrote it in `command` — `mcp.connect`, `mcp.status` or `mcp.disconnect` — and carries `schemaVersion`. `serve` writes none: its stdout is the protocol.

`connect` writes one line:

```json
{"command":"mcp.connect","alias":"pithy-acme-prod","environment":"prod","connectionId":"5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11","workerUrl":"https://acme-prod.acme.workers.dev","credential":"key","keyFile":"/home/you/.config/pithy/keys/5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11.jwk","trustId":null,"scopes":["manifest:read","support:threads:read"],"status":"registered","store":"user","clients":[{"client":"claude-code","scope":"user","path":"/home/you/.claude.json","state":"added","reason":null,"snippet":null}],"schemaVersion":1}
```

| Key | Meaning |
|---|---|
| `alias` | The connection's name, and its client entries' key |
| `environment` | The environment it administers |
| `connectionId` | The connection's id |
| `workerUrl` | The Worker the server calls |
| `credential` | `key` or `oidc` |
| `keyFile` | The private key written, or `null` for a trust |
| `trustId` | The trust registered, or `null` for a key |
| `scopes` | The connection's grant |
| `status` | `registered` for a key, `awaiting_first_call` for a trust |
| `store` | `user` or `project`: where the record went |
| `clients` | One row per client entry: `client`, `scope`, `path`, `state` (`added`, `updated`, `unchanged`, `refused`) and `reason` |

With `--update` the line carries `alias`, `environment`, `connectionId`, `scopesBefore` and `scopes`.

`status` writes one line: `connections`, each with `alias`, `environment`, `workerUrl`, `store`, `credential`, `keyFile`, `keyMode`, `keyProblem` (why `serve` would refuse the key, or `null`), `tokenSource` and `clients`.

`disconnect` writes one line: `alias` and `connected`, and when there was a connection, `environment`, `credential`, `revoked`, `keyFileRemoved`, `clients`, and for a trust `latency`.

## Errors

| Code | Exit | When |
|---|---|---|
| `validation/invalid_input` | 2 | A flag rule above, an `--oidc-token` that is none of its three spellings, or a purpose that cannot be stored |
| `input/required` | 2 | No `--purpose` with nothing to ask, `--update` with no `--scope`, or a custom issuer with no `--oidc-token` |
| `core/precondition_failed` | 3 | No signed-in session; a key file another user owns or others can read; a job with no identity token; a record its store may not hold; `disconnect` run in another project |
| `core/conflict` | 3 | The environment is already connected here, already holds a live key, or is connected to something other than an agent |
| `controlplane/not_connected` | 3 | `serve` or `--update` names a connection nobody made here |
| `core/upstream_failed` | 4 | The Worker or the CI token endpoint did not answer. Retryable |

## Examples

An agent on your machine, for production, reading the support inbox.

```
$ pithy mcp connect --env prod --purpose "Support triage, reading threads." --scope manifest:read --scope support:threads:read --client claude-code
Connection  pithy-acme-prod
Worker      https://acme-prod.acme.workers.dev
Scopes      manifest:read, support:threads:read
Key         /home/you/.config/pithy/keys/5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11.jwk (0600)
claude-code  added /home/you/.claude.json
Done.
```

The same agent's tools, as the client lists them: `controlplane_ping`, `controlplane_manifest_read`, `support_threads_list`, `support_threads_read`, `support_replies_list`.

An agent in GitHub Actions, for staging, with no key anywhere.

```
$ pithy mcp connect --env staging --purpose "Nightly audit summary." \
    --oidc-issuer https://token.actions.githubusercontent.com \
    --oidc-claim repository_id=1262274726 --oidc-claim environment=staging --client claude-code
Connection  pithy-acme-staging-ci
Worker      https://acme-staging.acme.workers.dev
Scopes      manifest:read, audit:events:read
Trust       9b1d4c2e-…
claude-code  added /home/you/app/.mcp.json
Nothing proves a trust until a job calls. Commit .pithy/mcp.jsonc and the client entry.
Done.
```

Where everything stands.

```
$ pithy mcp status
pithy-acme-staging-ci  trust, token from github
pithy-acme-prod        key /home/you/.config/pithy/keys/5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11.jwk 0600
```

Take one back.

```
$ pithy mcp disconnect --connection pithy-acme-prod
Revoked pithy-acme-prod.
claude-code  removed /home/you/.claude.json
Done.
```
