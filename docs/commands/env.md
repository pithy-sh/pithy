# pithy env

Report every Worker's environments — bindings, resolved ids, provisioned state, base URLs, and Cloudflare dashboard links — reading everything and writing nothing.

## Synopsis

```bash
pithy env [name] [--worker <name>] [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `[name]` (positional, optional) | Show only this environment, e.g. `staging`. Filters the **human** output only — see below. |
| `--worker <name>` | Show only this Worker, by the name `pithy worker list` shows or its `apps/<dir>` basename. Default: every Worker. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

`pithy env` is an inventory, not a switch. It writes nothing, changes nothing, and provisions nothing. Provisioning *health* and non-zero exits belong to `pithy doctor`; this command reports what is declared and what resolves, and a resource that does not exist is a line saying so rather than a failure.

Every Worker lives in `apps/<name>/` with its own `wrangler.jsonc`, so the report is per Worker × per environment. A Worker's top-level stanza is its `dev` environment; each `env.<name>` block is another. For each environment it lists every id-carrying binding — D1, KV, R2, and Durable Objects — with the id `wrangler.jsonc` declares, whether that id is real, and a link into the Cloudflare dashboard.

**Provisioned means the id is present and is not a placeholder.** An empty value, a `<database_id>` stub, or anything containing "placeholder" reads as not provisioned, which is exactly the state a freshly scaffolded project is in.

**A link is either right or absent.** A resource gets a deep link when its dashboard id is knowable, that product's list page when it is not, and nothing at all with no account id or when the resource is not provisioned. A Durable Object binding names a class, and the dashboard addresses a DO by a namespace id `wrangler.jsonc` never carries, so DO rows show the class name and fall back to the list page — resolving the real id would take a Cloudflare API call this command does not make. In a terminal an id renders as a clickable OSC-8 hyperlink; with hyperlinks off, piped, or under `NO_COLOR`, the URL is printed beside the id. `--json` always carries the full `dashboardUrl`.

The environment set comes from `wrangler.jsonc` alone, so the inventory prints in a project whose dependencies are not installed. A Worker's `pithy.config.ts` is read only for its `domains` declaration, and only opportunistically: missing, unimportable, or malformed leaves that declaration unresolved and the wrangler-derived report intact. A discovered process with no `wrangler.jsonc` — a Vite front end in the dev set — has no environments and is skipped.

`baseUrl` is `"local"` for `dev`, because a local run has no public address. For every other environment it is resolved offline, in order, from the `domains` declaration, then the first route pattern, then a hand-set `vars.BASE_URL` — and `null` when the Worker declares no address at all. The resolver is offline by construction, which is what lets a read-only command use it.

The account id is read from `<config>/cloudflare.json`, with `process.env` overlaid per key. It is absent under `PITHY_OFFLINE` with no file, and that is not an error: the inventory still prints, with a note and without links.

**The positional `name` filter applies to the human output only.** `--json` always carries every environment every selected Worker declares. Narrow the JSON with `--worker`, or filter the array yourself.

## `--json`

One line on stdout.

| key | type | meaning |
|---|---|---|
| `command` | string | `"env"`. |
| `accountId` | string \| null | The Cloudflare account id, or `null` — dashboard links are omitted when it is absent. |
| `workers` | object[] | Every selected Worker with a `wrangler.jsonc`, in discovery order. |
| `workers[].worker` | string | The Worker's name, as `pithy worker list` shows it. |
| `workers[].dir` | string | The Worker's directory, relative to the project root, e.g. `apps/api`. |
| `workers[].environments` | object[] | Every environment declared in that Worker's `wrangler.jsonc`, `dev` first. |
| `workers[].environments[].name` | string | `"dev"` for the top-level stanza, otherwise the `env.<name>` key. |
| `workers[].environments[].scriptName` | string \| null | The Worker script name this environment deploys under, or `null`. |
| `workers[].environments[].baseUrl` | string \| null | `"local"` for `dev`; the resolved public address otherwise; `null` when the Worker declares none. |
| `workers[].environments[].workerDashboardUrl` | string \| null | The dashboard link for this environment's Worker, or `null` with no account id or no script name. |
| `workers[].environments[].resources` | object[] | Every binding declared for this environment. |
| `…resources[].kind` | string | The resource kind: `"d1"`, `"kv"`, `"r2"`, or `"durable_object"`. |
| `…resources[].binding` | string | The Worker binding name, e.g. `DB` or `SESSIONS`. |
| `…resources[].id` | string \| null | The resolved id — a D1 uuid, a KV namespace id, an R2 bucket name, a DO class name — or `null` when absent. |
| `…resources[].provisioned` | boolean | True when the id is present, non-empty, and not a placeholder. |
| `…resources[].dashboardUrl` | string \| null | The resource's own dashboard page when its id is knowable, else that product's list page. `null` with no account id, when not provisioned, or for a kind with neither. |

## Errors

The command exits 0 for every state it is meant to report, including a completely unprovisioned project. Two things still refuse:

- **`No workers here.`** Nothing under `apps/` carries a `wrangler.jsonc`. Run `pithy init` to start a project.
- **`No worker named "<name>".`** `--worker` matched nothing. The refusal lists the Workers that do exist.

A Worker whose `wrangler.jsonc` vanished between discovery and reading is skipped rather than failing the inventory. A Worker whose config is present and will not open still refuses — a Worker silently missing from an inventory is the under-report this command exists to prevent.

## Examples

```bash
# Everything.
pithy env

# One environment, across every Worker.
pithy env staging

# One Worker, every environment, as JSON.
pithy env --worker api --json
```

```json
{"command":"env","accountId":"<account-id>","workers":[{"worker":"acme-api","dir":"apps/api","environments":[{"name":"dev","scriptName":"acme-api","baseUrl":"local","workerDashboardUrl":null,"resources":[{"kind":"d1","binding":"DB","id":"<database_id>","provisioned":false,"dashboardUrl":null}]},{"name":"prod","scriptName":"acme-prod-api","baseUrl":"https://api.example.com","workerDashboardUrl":"<dashboard-url>","resources":[{"kind":"d1","binding":"DB","id":"<database-id>","provisioned":true,"dashboardUrl":"<dashboard-url>"}]}]}]}
```

Nothing this command reads is a credential, and nothing it prints is one. An account id and a resource id are identifiers.
