# pithy deploy

_The site renders this for readers: [pithy.sh/docs/cli/commands/deploy](https://pithy.sh/docs/cli/commands/deploy). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Ship every Worker the project deploys to Cloudflare — the ones under `apps/` and one per composed capability that owns Workflows — then prove the version just shipped is the one answering at the address the project claims.

## Synopsis

```bash
pithy deploy [--env <env>] [--apps] [--kit] [--force] [--json]
```

The shipping model — environments, credentials, worker discovery, migrate-then-deploy — is [pithy.sh/docs/build/operations/deploy](https://pithy.sh/docs/build/operations/deploy). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. **No default.** Omitted, each Worker's top-level `wrangler.jsonc` stanza ships, which is not an environment at all — and the kit's Workers do not ship, because they are per environment. `dev` ships the Workers under `apps/` only: the kit's run locally under `pithy dev`. |
| `--apps` | Deploy only the Workers under `apps/`. |
| `--kit` | Deploy only the kit's Workers. Needs `--env staging` or `--env prod`. |
| `--force` | Deploy every kit Worker whether it changed or not. Needs `--env staging` or `--env prod`; refused beside `--apps`. |
| `--json` | Machine-readable output. Default `false`. |

There is no `--worker`. Deploy ships the whole set.

**No selector means both halves.** `--apps` and `--kit` each narrow it, and naming both is the same as naming neither — `pithy deploy --apps --kit` is `pithy deploy`, down to the line it prints when there is no environment for the kit half. They are two named steps rather than one list, which is the shape CI wants: separate exit codes, separate logs, and a failure that says which half broke.

**There is no `--if-changed`, in any spelling.** Gating is behavior, not a mode. Nobody wants to re-upload an identical prebuilt bundle, so a flag for it could only ever be passed — and a flag that can only ever be true is one somebody eventually leaves off believing it does something, which is the exact bug this closes. `--force` is the escape hatch for a recovery run.

## What it does

`apps/` is the registry: every `apps/<name>/` holding a `wrangler.jsonc` is one deployable Worker, and deploy ships them all. It runs `wrangler deploy [--env <env>]` in each Worker's own directory, against that Worker's own config, and lets wrangler own bundling, upload, bindings, and routes. Output is captured and summarized rather than streamed.

**A Worker that serves a front end is built first**, in its own directory, through the project's package manager, from its manifest's `ui.build`. The build carries the deploy's environment, because the Vite plugin resolves each capability's client-safe projection *for a named environment* — a build without it inlines dev values into a production bundle, silently. A failed build fails that Worker and skips its deploy: shipping a Worker whose assets are stale is worse than not shipping it.

**One Worker's failure does not abort the batch.** Every Worker is attempted and reported, and the command exits non-zero if any of them failed.

**Deploy verifies, and the verification can fail the command.** After a Worker ships to a named environment, deploy probes that Worker's *declared* domain — the `domains` declaration, then a route, then `vars.BASE_URL` — for `/health`, and asserts the running version matches the version id wrangler reported. Not the URL wrangler printed, which under gradual deployments may be a version-scoped preview; and not a liveness check, because the old version answering happily is precisely the failure worth catching. The probe retries with a short backoff. Seeing more than one version is a rollout in progress and reports `inconclusive`; a Worker that answered without a version is `inconclusive` too, since a project that has not adopted `CF_VERSION_METADATA` genuinely cannot say. Seeing one *other* version consistently is a `mismatch`. **Nothing answering at all is `unreachable`**, and that is a different fact from either: it is transport-level — DNS, TLS, a timeout, no route — and the detail names the address that did not answer rather than guessing at a binding. `mismatch` and `unreachable` both fail the command. There is nothing to verify on a bare deploy, on `dev`, when wrangler printed no version id, or when the Worker declares no address — all four are ordinary.

**Deploy refuses an environment whose named and served origins do not line up.** With `--env`, before anything is built or spawned. This gate and the one below it are about the Workers under `apps/`, so `--kit` is not held to them — a kit Worker whose environment is not ready is reported on its own row instead, which is the finer-grained answer to the same question. Every auth `baseURL`, OAuth callback, magic-link URL and CSRF allowed-origin is derived from an environment's origin, so when the config states none, each of them invents one — and the dangerous invention is production's, which is how a staging deploy emails real users magic links into production. Three shapes are refused, each naming the Worker, the environment and the edit:

- **No origin at all** — no `domains` declaration, no `routes` pattern, no `vars.BASE_URL` for that environment. Declare `domains.<env>` in the Worker's `pithy.config.ts`, or set `vars.BASE_URL` in its `env.<name>` stanza. `domains` has keys for `staging` and `prod` only, so an environment you declared yourself takes the second route.
- **A declared origin nothing serves** — `domains` (or `vars.BASE_URL`) names a host and no `routes` pattern in that `env.<name>` stanza covers it, so the Worker would ship and answer at no address. Run `pithy worker sync` to write the route from the declaration; an origin named by `vars.BASE_URL` was generated from nothing, so its `routes` entry is yours to write. This is the shape `"workers_dev": false` produces on a Worker whose route was never written — the remedy below, applied to a declaration nothing routed.
- **`workers.dev` left open beside a custom domain** — the Worker answers on the domain *and* on `<name>.<subdomain>.workers.dev`, which nothing decided about. Wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change it; `preview_urls` follows `workers_dev`, so every deployed version is reachable there too. On that origin `BASE_URL` names the other host and the CSRF same-origin gate refuses exactly the requests that establish who you are. Set `"workers_dev": false` in `env.<name>`, or `"workers_dev": true` to say you meant both — a named origin is the whole requirement, not a particular value.

`pithy init` and `pithy worker add` write the route and `"workers_dev": false` beside every domain they declare, so a project that answered the domain question meets this already; `pithy worker sync` writes the same thing for a `domains` block added by hand. A **feature environment is exempt**: it is ephemeral, has no declared domain by design, and `workers.dev` is how it is reached. `pithy doctor` reports the same drift without being asked, so it is findable before a deploy is attempted.

**Deploy refuses an environment that does not bind what its Workers declare.** With `--env`, beside the check above and before anything is built. An app capability's `workflows` map is written into `wrangler.jsonc` by `pithy worker sync` and by nothing else, so a job declared and never synced ships with no `workflows` entry and no `triggers.crons`: the binding fails on the Worker's first request, and the cron simply never fires — nothing errors, nothing logs, and nothing probes red. The invariant is one sentence — **what the app declares is what the stanza binds** — and it is asked as one comparison of the whole table, so a missing binding, a binding nothing declares, a stale cron and a binding carrying another environment's Workflow name are one refusal with one remedy: run `pithy worker sync`. A declaration that cannot be reduced to a stanza at all — a job with no `className` — is refused separately and sent to `pithy.config.ts`, because no command can write it. A **feature environment is exempt** here too: its stanza is generated under `.wrangler/` rather than written into the tracked `wrangler.jsonc` this reads. `pithy doctor` reports the same drift without being asked.

### The kit's Workers

A capability that owns Workflows ships a Worker of its own — `<project>-<env>-email`, `<project>-<env>-media`, and so on. You did not write it, and it has no request and no access to `pithy.config.ts`: its configuration is stamped into its vars when it is deployed. `EMAIL_THEME`, `BASE_URL`, one `EMAIL_MESSAGES_<locale>` per locale, the resolved binding ids, the cron. Edit a theme, fix a translation, move a base URL, and until that Worker is redeployed it keeps sending the old one. Nothing fails.

**Deploy ships them, and the set is discovered by composition.** Every app Worker's composed capabilities are intersected with the kit's registry, exactly as `pithy dev` does to run the same Workers locally. A capability added to your project joins with no CI change; a capability added to the kit joins with a release.

**They are gated, and it is not a flag.** Each one is deployed carrying a stamp naming the package version it was built from and a hash of its resolved configuration, and the next deploy compares both against what is live. Version and hash matching is the one case that skips. Two inputs because they answer different questions: a kit upgrade moves the version, a theme edit moves only the hash, and the config half is the silent one.

**When in doubt, it deploys.** No Worker on the account, a Worker carrying no stamp, a stamp this release cannot read, an account that would not answer — all deploy, and the row says which. A false redeploy costs seconds; a false skip is silent. Worst case the gate degrades to shipping every time, which is what deploy did before it existed. *Undeclared and unchanged are not the same fact.*

**Deploying is not provisioning.** `pithy deploy --kit` creates nothing. Every binding id it needs is read off your own tracked `wrangler.jsonc` files, offline, and the two account-scoped ids that are in no repository — `SECRETS_STORE_ID` and `CLOUDFLARE_ACCOUNT_ID` — come from the credentials this run resolved. A capability whose resources this environment has no id for is reported as `skipped`, naming the command that creates them — `pithy email provision --env prod` — and a run where **every** kit Worker was skipped that way exits 1, because it deployed no kit Worker at all. A Worker whose composing app Worker has no address for the environment is skipped too: the links it sends would go nowhere, and inventing an origin for them is worse than not shipping.

**In `dev` there is nothing to deploy.** A capability's Worker in `dev` is `pithy dev`'s: it is materialized under `.wrangler/pithy/hosts/` and run locally, there is no `<project>-dev-email` on your account for a stamp to gate, and a local run has no public address for the links it would send. So `pithy deploy --env dev` ships `apps/` and says `In dev the kit's Workers run locally under pithy dev, so none were deployed.` — it does not fail. Asking for that half by name in `dev` is refused instead, because the run would do nothing at all.

**A Worker whose `pithy.config.ts` will not load fails the command.** The kit's set is discovered by composition, so a Worker nobody can read hides every capability it composes — and the Workers those capabilities own would simply not ship. That is reported as its own line rather than a row (it names no capability), and it exits 1: a run that cannot say what it should have shipped is not a green build. A directory under `apps/` with no `pithy.config.ts` **and** no `wrangler.jsonc` is not that — it is a dev-only process, a front end joining the dev set through `pithy.worker.jsonc` alone, and it composes nothing by design.

**A missing `SECRETS_STORE_ID` is a skip, not a deploy.** `pithy add secrets` records it in your Pithy config directory, which a CI runner does not have — so export it in the job, or the five Workers that read a secret (`email`, `media`, `storage`, `payments`, `secrets`) are skipped with that sentence rather than deployed bound to a store that is not there and unable to read their master key.

**It deploys the configuration your project composes.** A kit Worker's config is resolved from the composed capability in `apps/<name>/pithy.config.ts` — your `media({ recordStore })`, your `vector({ indexes })`, your email theme — so `pithy deploy --env <env> --kit` and `pithy <capability> provision` resolve the same Worker to the same bytes. That is what makes `pithy deploy --env <env> --kit --force` a safe way to re-upload one without re-running a full provisioning pass.

**The adopter's Workers are never gated.** Your code is the thing that changed, and no stamp can see a bundle. `--force` is refused beside `--apps` for that reason rather than accepted and ignored.

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
| `kit` | object[] \| null | One entry per composed capability's Worker, in registry order. **`null`** when the kit half did not run — `--apps`, no `--env`, or `--env dev` — which is a different fact from it finding nothing. |
| `kit[].capability` | string | The capability that owns the Worker, e.g. `"email"`. |
| `kit[].worker` | string \| null | The deployed script name, e.g. `"acme-prod-email"`. `null` when the run never got far enough to derive one. |
| `kit[].outcome` | string | `"deployed"`, `"unchanged"`, `"skipped"`, or `"failed"`. |
| `kit[].reason` | string | One sentence saying why. Never empty, for every outcome. |
| `kitProblems` | string[] \| null | What stopped the kit half knowing the set: a Worker whose capabilities could not be read, a composition that would not assemble, a failure that ended the pass. Beside the rows rather than among them, because none of them names a capability. Non-empty exits 1. **`null`** exactly when `kit` is. |

**Exit code.** `0` when every Worker's `ok` is true, no Worker's verification is `mismatch` or `unreachable`, no kit Worker `failed`, `kitProblems` is empty, and the kit half did not skip every Worker it found; `1` otherwise. The JSON line is printed either way, so a CI step can read the payload and still gate on the status.

## Errors

- **`No pithy.config.ts here.`** Run it from a Pithy project.
- **`No deployable workers here.`** Nothing under `apps/` carries a `wrangler.jsonc`. Run `pithy worker add <name>`.
- **A Cloudflare account mismatch.** The project pins one account and the resolved credentials belong to another. Refused before wrangler is spawned, naming both ids and which source supplied the wrong one — a file is a local misconfiguration, the environment is a CI job pointed at the wrong tenant.
- **An environment whose named and served origins do not line up.** Refused before anything is built, naming the Worker, the environment, and the one edit that answers it. See the section above for the three shapes.
- **An environment that does not bind what its Workers declare.** Refused before anything is built, naming the Worker, both sides of the comparison — what the app declares and what the stanza binds — and `pithy worker sync`.
- **A Worker's build or deploy failing.** Reported per Worker on the row, not thrown. A build failure and a deploy failure read differently, because they have different fixes. wrangler's exit code and stderr are the `error` string.
- **`--kit needs an environment.`** and **`--force needs an environment.`** A kit Worker's configuration is stamped into its vars, so `<project>-staging-email` and `<project>-prod-email` are genuinely separate Workers with no top-level stanza to fall back on. A bare `pithy deploy` still runs — it ships `apps/` and says out loud that the kit half needed an environment, and so does `pithy deploy --apps --kit`, which is the same selection.
- **`--kit has nothing to deploy in dev.`** and **`--force has nothing to deploy in dev.`** The kit's Workers run locally under `pithy dev` in that environment, so a run narrowed to them would do nothing. `pithy deploy --env dev` itself still runs, ships `apps/`, and says so.
- **A Worker under `apps/` whose capabilities could not be read.** Reported as its own line beside the kit rows and exits 1 — the capabilities it composes are invisible, so their Workers would silently not ship.
- **`--force has nothing to do with --apps.`** Only the kit's Workers are gated.
- **A kit Worker's deploy failing.** Reported on its row as `failed`, not thrown, so the rest of the set is still attempted.
- **`--env` is validated at the flag** when one is given. `production` is answered with `prod`.

## Examples

```bash
# Ship each Worker's top-level stanza. The kit's Workers need an environment.
pithy deploy

# Ship everything for an environment. Migrate first.
pithy migrate --env prod --json
pithy deploy --env prod --json

# Your Workers only.
pithy deploy --env prod --apps

# The kit's only, deployed only where something changed.
pithy deploy --env prod --kit

# Re-upload every kit Worker, stamp or not. A recovery run.
pithy deploy --env prod --kit --force

# Your Workers in dev. The kit's run under pithy dev, so none are deployed.
pithy deploy --env dev
```

```yaml
- name: Deploy workers
  run: pithy deploy --env prod --json
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

```json
{"command":"deploy","env":"prod","pendingMigrations":0,"workers":[{"name":"acme-api","ok":true,"versionId":"<version-id>","url":"https://acme-prod-api.example.workers.dev","verification":"verified","verificationDetail":"https://api.example.com is serving the version just deployed."},{"name":"acme-web","ok":false,"built":false,"error":"vite build failed."}],"kit":[{"capability":"email","worker":"acme-prod-email","outcome":"unchanged","reason":"@pithy-sh/email 0.1.7 is deployed with this configuration."},{"capability":"media","worker":"acme-prod-media","outcome":"deployed","reason":"Its resolved configuration changed."}],"kitProblems":[]}
```

The two environment variables in the CI snippet are the names of secrets your provider holds. No value appears here, and no `pithy deploy` payload can carry one.
