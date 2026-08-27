# pithy deploy

_The site renders this for readers: [pithy.sh/docs/cli/commands/deploy](https://pithy.sh/docs/cli/commands/deploy). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Ship every Worker in the project to Cloudflare, then prove the version just shipped is the one answering at the address the project claims.

## Synopsis

```bash
pithy deploy [--env <env>] [--json]
```

The shipping model — environments, credentials, worker discovery, migrate-then-deploy — is [pithy.sh/docs/build/operations/deploy](https://pithy.sh/docs/build/operations/deploy). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. **No default.** Omitted, each Worker's top-level `wrangler.jsonc` stanza ships, which is not an environment at all. |
| `--json` | Machine-readable output. Default `false`. |

There is no `--worker`. Deploy ships the whole set.

## What it does

`apps/` is the registry: every `apps/<name>/` holding a `wrangler.jsonc` is one deployable Worker, and deploy ships them all. It runs `wrangler deploy [--env <env>]` in each Worker's own directory, against that Worker's own config, and lets wrangler own bundling, upload, bindings, and routes. Output is captured and summarized rather than streamed.

**A Worker that serves a front end is built first**, in its own directory, through the project's package manager, from its manifest's `ui.build`. The build carries the deploy's environment, because the Vite plugin resolves each capability's client-safe projection *for a named environment* — a build without it inlines dev values into a production bundle, silently. A failed build fails that Worker and skips its deploy: shipping a Worker whose assets are stale is worse than not shipping it.

**One Worker's failure does not abort the batch.** Every Worker is attempted and reported, and the command exits non-zero if any of them failed.

**Deploy verifies, and the verification can fail the command.** After a Worker ships to a named environment, deploy probes that Worker's *declared* domain — the `domains` declaration, then a route, then `vars.BASE_URL` — for `/health`, and asserts the running version matches the version id wrangler reported. Not the URL wrangler printed, which under gradual deployments may be a version-scoped preview; and not a liveness check, because the old version answering happily is precisely the failure worth catching. The probe retries with a short backoff. Seeing more than one version is a rollout in progress and reports `inconclusive`; a Worker that answered without a version is `inconclusive` too, since a project that has not adopted `CF_VERSION_METADATA` genuinely cannot say. Seeing one *other* version consistently is a `mismatch`. **Nothing answering at all is `unreachable`**, and that is a different fact from either: it is transport-level — DNS, TLS, a timeout, no route — and the detail names the address that did not answer rather than guessing at a binding. `mismatch` and `unreachable` both fail the command. There is nothing to verify on a bare deploy, on `dev`, when wrangler printed no version id, or when the Worker declares no address — all four are ordinary.

**Deploy refuses an environment whose named and served origins do not line up.** With `--env`, before anything is built or spawned. Every auth `baseURL`, OAuth callback, magic-link URL and CSRF allowed-origin is derived from an environment's origin, so when the config states none, each of them invents one — and the dangerous invention is production's, which is how a staging deploy emails real users magic links into production. Three shapes are refused, each naming the Worker, the environment and the edit:

- **No origin at all** — no `domains` declaration, no `routes` pattern, no `vars.BASE_URL` for that environment. Declare `domains.<env>` in the Worker's `pithy.config.ts`, or set `vars.BASE_URL` in its `env.<name>` stanza. `domains` has keys for `staging` and `prod` only, so an environment you declared yourself takes the second route.
- **A declared origin nothing serves** — `domains` (or `vars.BASE_URL`) names a host and no `routes` pattern in that `env.<name>` stanza covers it, so the Worker would ship and answer at no address. Run `pithy worker sync` to write the route from the declaration; an origin named by `vars.BASE_URL` was generated from nothing, so its `routes` entry is yours to write. This is the shape `"workers_dev": false` produces on a Worker whose route was never written — the remedy below, applied to a declaration nothing routed.
- **`workers.dev` left open beside a custom domain** — the Worker answers on the domain *and* on `<name>.<subdomain>.workers.dev`, which nothing decided about. Wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change it; `preview_urls` follows `workers_dev`, so every deployed version is reachable there too. On that origin `BASE_URL` names the other host and the CSRF same-origin gate refuses exactly the requests that establish who you are. Set `"workers_dev": false` in `env.<name>`, or `"workers_dev": true` to say you meant both — a named origin is the whole requirement, not a particular value.

`pithy init` and `pithy worker add` write the route and `"workers_dev": false` beside every domain they declare, so a project that answered the domain question meets this already; `pithy worker sync` writes the same thing for a `domains` block added by hand. A **feature environment is exempt**: it is ephemeral, has no declared domain by design, and `workers.dev` is how it is reached. `pithy doctor` reports the same drift without being asked, so it is findable before a deploy is attempted.

**Deploy refuses an environment that does not bind what its Workers declare.** With `--env`, beside the check above and before anything is built. An app capability's `workflows` map is written into `wrangler.jsonc` by `pithy worker sync` and by nothing else, so a job declared and never synced ships with no `workflows` entry and no `triggers.crons`: the binding fails on the Worker's first request, and the cron simply never fires — nothing errors, nothing logs, and nothing probes red. The invariant is one sentence — **what the app declares is what the stanza binds** — and it is asked as one comparison of the whole table, so a missing binding, a binding nothing declares, a stale cron and a binding carrying another environment's Workflow name are one refusal with one remedy: run `pithy worker sync`. A declaration that cannot be reduced to a stanza at all — a job with no `className` — is refused separately and sent to `pithy.config.ts`, because no command can write it. A **feature environment is exempt** here too: its stanza is generated under `.wrangler/` rather than written into the tracked `wrangler.jsonc` this reads. `pithy doctor` reports the same drift without being asked.

**Deploy never migrates.** With `--env`, it takes a best-effort count of unapplied migrations for that environment and warns when the schema is behind. A config it cannot load or a database it cannot reach yields no warning rather than a failed deploy. Promote the schema with `pithy migrate` first, then ship.

Every Worker deploy — success and failure — is audited as `deploy/worker_deployed` when the project has audit wired, recording the Worker, the version id, and the verification outcome. Shipping to `prod` is recorded at warning severity; everything else is routine.

Credentials are `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, resolved from the account the project's root `pithy.config.ts` names — `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` — and passed explicitly to wrangler, so a local deploy authenticates the same way CI does. The account is resolved before anything else, and a pinned `cloudflare.accountId` that disagrees with the credentials refuses before wrangler is ever spawned. That refusal is the point: a deploy that authenticates against the wrong tenant succeeds, and says nothing.

## `--json`

One line on stdout, after every Worker has been attempted. A failure inside the command — no project, no deployable Workers — is one `{"error": …}` line on stderr instead. A failed *deploy* is reported in the payload, and the exit code is 1.

| key | type | meaning |
|---|---|---|
| `command` | string | `"deploy"`. |
| `env` | string \| null | The environment deployed, or `null` for a bare deploy of each Worker's top-level stanza. |
| `pendingMigrations` | number \| null | Unapplied migrations for the target environment. `null` with no `--env`, and `null` when the count could not be taken — deploy never fails over it. |
| `workers` | object[] | One entry per Worker, in discovery order. Every Worker is attempted. |
| `workers[].name` | string | The Worker's name. |
| `workers[].ok` | boolean | Whether `wrangler deploy` succeeded for this Worker. |
| `workers[].versionId` | string, optional | The deployed version id, when wrangler's output carried one. |
| `workers[].url` | string, optional | The public URL wrangler printed, when it printed one. |
| `workers[].built` | boolean, optional | Whether this Worker's UI build ran and succeeded. **Absent** when the Worker declares no `ui` block — so `false` means the build is what failed and the deploy never ran. |
| `workers[].error` | string, optional | The failure reason. Present only when `ok` is `false`. |
| `workers[].verification` | string, optional | What probing the declared domain concluded: `"verified"`, `"mismatch"`, `"inconclusive"`, or `"unreachable"`. Absent when there was nothing to check. |
| `workers[].verificationDetail` | string, optional | The one-line explanation behind `verification`. |

**Exit code.** `0` when every Worker's `ok` is true and no Worker's verification is `mismatch` or `unreachable`; `1` otherwise. The JSON line is printed either way, so a CI step can read the payload and still gate on the status.

## Errors

- **`No pithy.config.ts here.`** Run it from a Pithy project.
- **`No deployable workers here.`** Nothing under `apps/` carries a `wrangler.jsonc`. Run `pithy worker add <name>`.
- **A Cloudflare account mismatch.** The project pins one account and the resolved credentials belong to another. Refused before wrangler is spawned, naming both ids and which source supplied the wrong one — a file is a local misconfiguration, the environment is a CI job pointed at the wrong tenant.
- **An environment whose named and served origins do not line up.** Refused before anything is built, naming the Worker, the environment, and the one edit that answers it. See the section above for the three shapes.
- **An environment that does not bind what its Workers declare.** Refused before anything is built, naming the Worker, both sides of the comparison — what the app declares and what the stanza binds — and `pithy worker sync`.
- **A Worker's build or deploy failing.** Reported per Worker on the row, not thrown. A build failure and a deploy failure read differently, because they have different fixes. wrangler's exit code and stderr are the `error` string.
- **`--env` is validated at the flag** when one is given. `production` is answered with `prod`.

## Examples

```bash
# Ship each Worker's top-level stanza.
pithy deploy

# Ship an environment. Migrate first.
pithy migrate --env prod --json
pithy deploy --env prod --json
```

```yaml
- name: Deploy workers
  run: pithy deploy --env prod --json
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

```json
{"command":"deploy","env":"prod","pendingMigrations":0,"workers":[{"name":"acme-api","ok":true,"versionId":"<version-id>","url":"https://acme-prod-api.example.workers.dev","verification":"verified","verificationDetail":"https://api.example.com is serving the version just deployed."},{"name":"acme-web","ok":false,"built":false,"error":"vite build failed."}]}
```

The two environment variables in the CI snippet are the names of secrets your provider holds. No value appears here, and no `pithy deploy` payload can carry one.
