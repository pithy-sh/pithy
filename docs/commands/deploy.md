# pithy deploy

_The site renders this for readers: [pithy.sh/docs/cli/commands/deploy](https://pithy.sh/docs/cli/commands/deploy). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Ship every Worker the project deploys to Cloudflare — the ones under `apps/` and one per composed capability that owns Workflows — then prove the version just shipped is the one answering at the address the project claims.

## Synopsis

```bash
pithy deploy [--env <env>] [--apps] [--kit] [--force] [--dry-run] [--json [--events]]
```

The shipping model — environments, credentials, worker discovery, migrate-then-deploy — is [pithy.sh/docs/build/operations/deploy](https://pithy.sh/docs/build/operations/deploy). This page is the command surface.

## Flags

| Flag | Meaning |
|---|---|
| `--env <env>` | Target environment: `dev`, `staging`, `prod`. **No default.** Omitted, each Worker's top-level `wrangler.jsonc` stanza ships, which is not an environment at all. `dev` is that same stanza. Both are refused while any D1 or KV binding in it has no id, and `pithy add` writes them without one — so for a project composing a capability that binds either, neither ships. The kit's Workers ship in neither: they are per environment, and in `dev` they run locally under `pithy dev`. |
| `--apps` | Deploy only the Workers under `apps/`. |
| `--kit` | Deploy only the kit's Workers. Needs `--env staging` or `--env prod`. |
| `--force` | Deploy every kit Worker whether it changed or not. Needs `--env staging` or `--env prod`; refused beside `--apps`. |
| `--dry-run` | Show the plan and upload nothing: the migrations it would leave unapplied, and each Worker it would upload, after building it and running `wrangler deploy --dry-run` on it. Default `false`. |
| `--json` | Machine-readable output. Default `false`. |
| `--events` | With `--json`, a progress record per line as the deploy goes, closed by the `--json` document. Refused without `--json`: `--events needs --json.` `--events=true` and `--events=false` are read too, and any other value is refused, as is `--no-events=<value>`, which the parse does not read. Default `false`. |

There is no `--worker`. Deploy ships the whole set.

**No selector means both halves.** `--apps` and `--kit` each narrow it, and naming both is the same as naming neither — `pithy deploy --apps --kit` is `pithy deploy`, down to the line it prints when there is no environment for the kit half. They are two named steps rather than one list, which is the shape CI wants: separate exit codes, separate logs, and a failure that says which half broke.

**There is no `--if-changed`, in any spelling.** Gating is behavior, not a mode. Nobody wants to re-upload an identical prebuilt bundle, so a flag for it could only ever be passed — and a flag that can only ever be true is one somebody eventually leaves off believing it does something, which is the exact bug this closes. `--force` is the escape hatch for a recovery run.

## What it does

`apps/` is the registry: every `apps/<name>/` holding a `wrangler.jsonc` is one deployable Worker, and deploy ships them all. It runs `wrangler deploy [--env <env>] --experimental-provision=false` in each Worker's own directory, against that Worker's own config, and lets wrangler own bundling, upload, bindings, and routes. Output is captured and summarized rather than streamed.

**It says what it is on, while it is on it.** Capturing wrangler's output is the right call and it is not being reversed — but it removed the only evidence the command was alive, and this command used to print nothing whatever until every Worker had finished. So each Worker is named as it is reached, `▸ acme-api...`, and **its own summary line is printed the moment that Worker settles** rather than being held to a block at the end. The per-Worker lines moved; they are not printed twice. The migration warning now comes first, before the first upload, because it is about the schema this deploy is shipping code against.

These are plain lines, printed once and never redrawn — no spinner, no cursor movement — so a redirected stdout and a CI log take them unharmed. **The only thing that silences them is `--json`**, which still writes exactly one line. Not a missing TTY: a run in CI is the run whose log most needs to say where it got to. **`--json --events` says them as records instead**, for a program that wants to know where a long deploy got to (see [`--events`](#--events)).

**A Worker that serves a front end is built first**, in its own directory, through the project's package manager, from its manifest's `ui.build`. A failed build fails that Worker and skips its deploy: shipping a Worker whose assets are stale is worse than not shipping it.

**The build is told which environment it is, by both names.** `ENVIRONMENT` is the name the deployed Worker answers to and the one `@pithy-sh/vite` resolves each capability's client-safe projection against — a build without it inlines dev values into a production bundle, silently. `CLOUDFLARE_ENV` is the one `@cloudflare/vite-plugin` reads to select the wrangler stanza it builds, and nothing set it: every front end was built from the **top-level** stanza however loudly `--env staging` was typed, and because `vite build` writes a `.wrangler/deploy/config.json` that redirects the following `wrangler deploy` to that build output, the dev stanza is what shipped — with dev bindings, dev vars, no routes, and `workers.dev` open. Two variables, two jobs. A feature environment is told a third thing, `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, because its ids are generated under `.wrangler/` rather than written into the tracked `wrangler.jsonc`; the build reads that file, and wrangler then deploys what the build wrote. `--env dev` sets no `CLOUDFLARE_ENV` and passes no `--env`, because `dev` is the top-level stanza rather than an `env.dev` — no project is allowed to declare one.

**A deploy cannot publish a configuration that is not the requested environment's.** After the build and before the upload, deploy resolves the configuration wrangler will actually read — an explicit `--config`, else the `.wrangler/deploy/config.json` redirect, else the Worker's own `wrangler.jsonc` — and holds it to what the project declares for the environment that was asked for: the script name, and `vars.ENVIRONMENT`. They disagree and that Worker is not deployed, naming the file it was about to ship. This is stated as what must be true rather than as a list of ways to get it wrong, because the class has already produced two mechanisms in one command: a build emitting the wrong stanza, and a `--config` overriding the one that was built. The refusal is per Worker, like a build failure, so the rest of the set is still attempted and the command exits 1.

**A deploy creates nothing.** wrangler's own default, for every deploy that is not a dry run, is to *create* any resource a binding names and it cannot find — a D1 with a `database_name` and no id, a KV namespace, an R2 bucket that does not exist, and five kinds besides. That is how a `pithy deploy --env staging` once left two empty databases on an account. So every `wrangler deploy` this command runs carries `--experimental-provision=false`, and one that does not is refused before it is spawned, on the Workers under `apps/` and the kit's alike. The switch is wrangler's rather than a check over the config because for R2, queues and the namespace kinds the name *is* the id: no reading of a file tells a bucket that exists from one wrangler is about to make. wrangler rejects arguments it does not know, so if it ever drops the switch, a deploy fails loudly rather than creating anything. `pithy provision` is the step that creates resources, and it asks first. The `deploy` scripts `pithy init` and `pithy worker add` write carry the same switch.

**Deploy refuses a stanza whose bindings have no id.** Before anything is built, for every deploy of the Workers under `apps/` — bare, `--env dev`, a named environment and a feature environment alike. It reads the stanza the deploy ships: the top level for a bare deploy and for `dev`, which is the top level rather than an `env.dev`; `env.<name>` for a named environment, or the top level when a Worker has no such stanza, because that is what wrangler ships for it; and the generated config under `.wrangler/` for a feature environment. Each D1 and KV binding with no id — absent, empty, or a `<placeholder>` — is named, `board.DB (d1)`, with the command that gives it one: `pithy provision --env <name> --yes`, or `pithy provision --feature`. The top-level stanza is dev's, run by `pithy dev` against Miniflare, which needs no id and has nothing on an account to provision — so a bare deploy and `--env dev` are sent to `--env staging` or `--env prod` instead. A named R2 bucket is not visible to this check; the switch above is what stops a missing one being created, and wrangler's upload is what fails on it.

**Deploy refuses a rate-limit namespace in the feature range (#643).** Before anything is built, for every selection and every environment, a bare deploy and `--kit` included: any Worker under `apps/` whose tracked `wrangler.jsonc` declares a `namespace_id` from 1000000000 through 1999999999, at the top level or in any stanza, is refused. Every feature of every project in the account binds its limiters in that range, so a declared id there would share counters with a branch. The id is read as the integer it spells, so `"01031275746"` is refused as `1031275746`. A feature's ids live in the generated config under `.wrangler/`, which this does not read. The kit writes limiters from 1000 through 9999.

**One Worker's failure does not abort the batch.** Every Worker is attempted and reported, and the command exits non-zero if any of them failed.

**Deploy verifies, and the verification can fail the command.** After a Worker ships to a named environment, deploy probes that Worker's *declared* domain — the `domains` declaration, then a route, then `vars.BASE_URL` — for `/health`, and asserts the running version matches the version id wrangler reported. Not the URL wrangler printed, which under gradual deployments may be a version-scoped preview; and not a liveness check, because the old version answering happily is precisely the failure worth catching. The probe retries on a doubling schedule — about a minute in all — because a custom domain takes time to route to a new version, and a window of seconds reported two correct deploys as a `mismatch` before #677. A verified deploy still costs one request: the probe stops at the first sighting. A Worker that answers `200` without a version has nothing the probe can ever match, so after three such answers it concludes `inconclusive` rather than waiting out the minute — a non-2xx is not that, since a Worker still coming up may report a version on the next probe, and it keeps the full window. Seeing more than one version is a rollout in progress and reports `inconclusive`; a Worker that answered without a version is `inconclusive` too, since a project that has not adopted `CF_VERSION_METADATA` genuinely cannot say. Seeing one *other* version consistently is a `mismatch`. **Nothing answering at all is `unreachable`**, and that is a different fact from either: it is transport-level — DNS, TLS, a timeout, no route — and the detail names the address that did not answer rather than guessing at a binding. `mismatch` and `unreachable` both fail the command, and both read as failures: the line says `deployed, and not verified.` rather than `deployed.` with the finding indented underneath it. The upload did happen and the line still says so; what it must not say is that the deploy was fine. There is nothing to verify on a bare deploy, on `dev`, when wrangler printed no version id, or when the Worker declares no address — all four are ordinary. **A feature deploy is verified too**, against the `workers.dev` origin `pithy provision --feature` stamped, read from the generated config that was just deployed rather than the tracked `wrangler.jsonc` — and not at all when a `workers_dev: false`, the Worker's own or the top level's that wrangler inherits, means it answers on no `workers.dev` address. Its kit Workers are named for the feature: `pithy deploy --env feature` reads the feature off the branch, reads each id from the generated config's `env.feature` stanza, and redeploys every kit Worker the feature composes when it changed. A kit Worker any of whose names — script, Workflow, bucket, index or store entry — is not the feature's fails its row rather than deploy as `<project>-feature-<capability>`, one Worker every branch would share; and an app Worker whose directory would give it a kit host's name is refused.

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

**Deploying is not provisioning.** `pithy deploy --kit` creates nothing: a kit Worker is deployed with `--experimental-provision=false` too. Media and storage derive their bucket's name from the project, and nothing offline can say whether it exists — so a bucket nobody provisioned fails that Worker's row as `failed`, with wrangler's error, rather than being created by the upload. Every binding id it needs is read off your own tracked `wrangler.jsonc` files, offline, and the two account-scoped ids that are in no repository — `SECRETS_STORE_ID` and `CLOUDFLARE_ACCOUNT_ID` — come from the credentials this run resolved. A capability whose resources this environment has no id for is reported as `skipped`, naming the command that creates them — `pithy email provision` — and a run where **every** kit Worker was skipped that way exits 1, because it deployed no kit Worker at all. A Worker whose composing app Worker has no address for the environment is skipped too: the links it sends would go nowhere, and inventing an origin for them is worse than not shipping.

**In `dev` there is nothing to deploy.** A capability's Worker in `dev` is `pithy dev`'s: it is materialized under `.wrangler/pithy/hosts/` and run locally, there is no `<project>-dev-email` on your account for a stamp to gate, and a local run has no public address for the links it would send. So the kit half of `pithy deploy --env dev` does not fail: it says `In dev the kit's Workers run locally under pithy dev, so none were deployed.` The run reaches that line only when the top-level stanza has no binding without an id. A capability that binds a D1 database or a KV namespace writes one there, so that project's `pithy deploy --env dev` is refused before anything is built, naming the binding and sending you to `--env staging` or `--env prod`, and exits 2 with no kit line: the call aimed at a stanza that never has resources. Asking for the kit half by name in `dev` is refused too, because the run would do nothing at all.

**A Worker whose `pithy.config.ts` will not load fails the command.** The kit's set is discovered by composition, so a Worker nobody can read hides every capability it composes — and the Workers those capabilities own would simply not ship. That is reported as its own line rather than a row (it names no capability), and it exits 1: a run that cannot say what it should have shipped is not a green build. A directory under `apps/` with no `pithy.config.ts` **and** no `wrangler.jsonc` is not that — it is a dev-only process, a front end joining the dev set through `pithy.worker.jsonc` alone, and it composes nothing by design.

**A missing `SECRETS_STORE_ID` is a skip, not a deploy.** `pithy add secrets` records it in your Pithy config directory, which a CI runner does not have — so export it in the job, or the five Workers that read a secret (`email`, `media`, `storage`, `payments`, `secrets`) are skipped with that sentence rather than deployed bound to a store that is not there and unable to read their master key.

**It deploys the configuration your project composes.** A kit Worker's config is resolved from the composed capability in `apps/<name>/pithy.config.ts` — your `media({ recordStore })`, your `vector({ indexes })`, your email theme — so `pithy deploy --env <env> --kit` and `pithy <capability> provision` resolve the same Worker to the same bytes. That is what makes `pithy deploy --env <env> --kit --force` a safe way to re-upload one without re-running a full provisioning pass.

**The adopter's Workers are never gated.** Your code is the thing that changed, and no stamp can see a bundle. `--force` is refused beside `--apps` for that reason rather than accepted and ignored.

**Deploy never migrates.** With `--env`, it takes a best-effort count of unapplied migrations for that environment and warns when the schema is behind. A config it cannot load or a database it cannot reach yields no warning rather than a failed deploy. Promote the schema with `pithy migrate` first, then ship.

### Seeing it first: `--dry-run`

`--dry-run` is Pithy's plan, then wrangler's, and it uploads nothing. The plan is the shape every `--dry-run` shares (`docs/CLI.md` §1.2).

- **Every gate the deploy refuses on refuses the dry run too, first.** A binding with no id, a rate-limit namespace in the feature range, an undeclared origin, an unbound Workflow: each is the deploy's own refusal, with its exit code and its `fix`, and under `--json` it is the one error line on stderr with nothing on stdout. A plan for a deploy that would be refused is a promise nobody can keep. Then Pithy's plan: the migrations the environment has not applied are read the way `pithy migrate --dry-run` reads them, and named in a note beside the command that applies them. They are never `plan.migrations`: that list is what a command would apply, and a deploy applies none. A ledger it cannot read is a note too, never a failure, because a deploy never fails over one.
- **Then each Worker under `apps/` is built and handed to `wrangler deploy --dry-run`**, on the deploy's own argv, under its own `▸` step. wrangler bundles and validates and stops, so a bundle that does not build fails its row here, with the build's error or wrangler's, rather than at the deploy. A Worker it accepts is one `plan.resources` upload. Nothing is probed and nothing is audited, because nothing shipped.
- **The build and the bundle happen in a private copy of the project**, under the system temporary directory, and the copy is gone before the command exits. So `dist/`, `.wrangler/` and whatever the build's own hooks write land in the copy, and the project is byte-identical afterwards; a failure names the project's paths, never the copy's. A directory the project links to from outside it — an `apps/api/src` kept in a shared checkout — is in the copy as a snapshot of that directory, so the bundle reads the source the deploy would. Two things differ from the deploy, and both are said here rather than discovered. The installed packages are reached through a link to `node_modules`, so a build that keeps a cache there writes that cache. And no `.dev.vars` file is copied, nor a `.env` file git does not track, because a secret has no business in a temporary directory, so a build that reads one builds without it. A `.env` file the repository tracks — an `apps/web/.env.production` a front end's build reads — is copied, because committing it said it is no secret; with no repository to ask, none is.
- **The kit half reads each stamp and stops.** A kit Worker the deploy would upload is a `plan.resources` upload with the deploy's reason; one that is current, or that this environment cannot deploy yet, stays a `kit` row with the outcome the deploy would print. No temporary config is written and no wrangler runs.

**It writes nothing in the project, and only reads the account.** The build's output — `dist/` and the `.wrangler/deploy/config.json` redirect — and wrangler's scratch under `.wrangler/` land in the copy and go with it. The one write that reaches past the copy is a cache a build keeps in `node_modules`.

```console
$ pithy deploy --env staging --dry-run
▸ acme-api...
acme-api: would deploy.
Would upload worker acme-api (staging).
1 migration unapplied for staging: 1000_app_0001_things. Deploy does not migrate — run pithy migrate --env staging.
Dry run. Nothing uploaded.
```

It exits the way the deploy would have: with the refusal's class when a gate refuses — 3 for a binding with no id in a named environment, 2 for one in the top-level stanza — else 3 when a Worker's row carries `exit: 3`, else 1 when a Worker's bundle or a kit Worker would fail, else 0.

Every Worker deploy — success and failure — is audited as `deploy/worker_deployed` when the project has audit wired, recording the Worker, the version id, and the verification outcome. Shipping to `prod` is recorded at warning severity; everything else is routine.

Credentials are `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, resolved from the account the project's root `pithy.config.ts` names — `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` — and passed explicitly to wrangler, so a local deploy authenticates the same way CI does. The account is resolved before anything else, and a pinned `cloudflare.accountId` that disagrees with the credentials refuses before wrangler is ever spawned. That refusal is the point: a deploy that authenticates against the wrong tenant succeeds, and says nothing.

## `--json`

One line on stdout, after every Worker has been attempted — or, under `--events`, the last line of a stream (below). A failure inside the command — no project, no deployable Workers — is one `{"error": …}` line on stderr instead. A failed *deploy* is reported in the payload, and the exit code is 1 — except that a run whose failed Worker row carries `exit` exits with the first such row's `exit`.

| key | type | meaning |
|---|---|---|
| `command` | string | `"deploy"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `env` | string \| null | The environment deployed, or `null` for a bare deploy of each Worker's top-level stanza. |
| `pendingMigrations` | number \| null | Unapplied migrations for the target environment. `null` with no `--env`, and `null` when the count could not be taken — deploy never fails over it. Under `--dry-run`, the number of migrations `plan.notes` names. |
| `workers` | object[] | One entry per Worker, in discovery order. Every Worker is attempted. |
| `workers[].name` | string | The Worker's name. |
| `workers[].ok` | boolean | Whether `wrangler deploy` succeeded for this Worker. Under `--dry-run`, whether `wrangler deploy --dry-run` accepted its bundle; such a row carries no `versionId`, `url` or `verification`, because nothing shipped. |
| `workers[].versionId` | string, optional | The deployed version id, when wrangler's output carried one. |
| `workers[].url` | string, optional | An address wrangler listed under this Worker's deployed triggers — its `workers.dev` host, or the host a custom domain or a route answers on. **Absent** when no trigger is an address: a cron, a queue or a workflow trigger is not one, and neither is a wildcard route. |
| `workers[].built` | boolean, optional | Whether this Worker's UI build ran and succeeded. **Absent** when the Worker declares no `ui` block — so `false` means the build is what failed and the deploy never ran. |
| `workers[].error` | string, optional | The failure reason. Present only when `ok` is `false` — the build's output, wrangler's, or the refusal to publish a configuration that is not the requested environment's, which names the file it was about to ship. |
| `workers[].exit` | integer, optional | The exit a classified failure carries: `3` when Cloudflare refused the credentials or wrangler would not start after an earlier Worker already had a row. **Absent** on an ordinary failure. |
| `workers[].verification` | string, optional | What probing the declared domain concluded: `"verified"`, `"mismatch"`, `"inconclusive"`, or `"unreachable"`. Absent when there was nothing to check. |
| `workers[].verificationDetail` | string, optional | The one-line explanation behind `verification`. |
| `kit` | object[] \| null | One entry per composed capability's Worker, in registry order. **`null`** when the kit half did not run — `--apps`, no `--env`, or `--env dev` — which is a different fact from it finding nothing. Under `--dry-run`, a Worker the deploy would upload is in `plan.resources` instead, so no row says `deployed`. |
| `kit[].capability` | string | The capability that owns the Worker, e.g. `"email"`. |
| `kit[].worker` | string \| null | The deployed script name, e.g. `"acme-prod-email"`. `null` when the run never got far enough to derive one. |
| `kit[].outcome` | string | `"deployed"`, `"unchanged"`, `"skipped"`, or `"failed"`. |
| `kit[].reason` | string | One sentence saying why. Never empty, for every outcome. |
| `kitProblems` | string[] \| null | What stopped the kit half knowing the set: a Worker whose capabilities could not be read, a composition that would not assemble, a failure that ended the pass. Beside the rows rather than among them, because none of them names a capability. Non-empty exits 1. **`null`** exactly when `kit` is. |
| `dryRun` | boolean | Whether this was `--dry-run`. Nothing was uploaded when it is `true`. |
| `plan` | object | Present only under `--dry-run`: `plan.resources` holds each Worker it would upload, and `plan.notes` the migrations it would leave unapplied, in the shape every `--dry-run` shares (`docs/CLI.md` §1.2). |
| `next` | object[] | `[{ command, why }]`: `pithy migrate --env <env>` when `pendingMigrations` is above zero and every Worker shipped, because deploy never migrates. Absent otherwise — on a bare deploy, which counts nothing, on a failed run, and under `--dry-run` — and never empty (`docs/CLI.md` §1.2). |

**Exit code.** `0` when every Worker's `ok` is true, no Worker's verification is `mismatch` or `unreachable`, no kit Worker `failed`, `kitProblems` is empty, and the kit half did not skip every Worker it found; `3` when a Worker's row carries `exit: 3`, because the credentials or wrangler are the next step whatever else failed; `1` otherwise. The JSON line is printed either way, so a CI step can read the payload and still gate on the status. Under `--dry-run` the code is the one the deploy would have exited with: a gate's refusal is its error line and its class, and a row that would fail is this payload and 1 — see the section above.

### `--events`

`--json --events` turns the one line into a stream: **one compact JSON record per line as each step starts and settles, then the document above as the last line.** It is framed as `pithy dev --json` is, so every line is compact and unpainted whatever `--pretty` or `PITHY_JSON` asked for, and a reader takes it line by line. The last line has no `event` key and every record before it has one, which is how a reader tells them apart. Without `--json` it is refused: `--events needs --json.`, exit 2.

| record key | type | meaning |
|---|---|---|
| `command` | string | `"deploy"`, on every record. |
| `schemaVersion` | integer | The same version the document carries. |
| `event` | string | `"start"` as a step begins, `"settled"` as it ends. |
| `what` | string | `start` only: what is being worked on — a Worker's name, or the build step. |
| `line` | string | `settled` only: the line a person would have read for it, without color. |
| `worker` | object, optional | `settled` only: the row a Worker under `apps/` settled as, exactly as `workers[]` lists it. |
| `kit` | object, optional | `settled` only: the row a kit Worker settled as, exactly as `kit[]` lists it. |

A failure inside the command ends the stream with no document, and the `{"error": …}` line goes to stderr as it always does. `pithy schema deploy --json` publishes the record's JSON Schema as `events`.

```console
$ pithy deploy --env staging --apps --json --events
{"command":"deploy","schemaVersion":1,"event":"start","what":"acme-api"}
{"command":"deploy","schemaVersion":1,"event":"settled","line":"acme-api: deployed. https://acme-staging-api.example.workers.dev <version-id>","worker":{"name":"acme-api","ok":true,"versionId":"<version-id>","url":"https://acme-staging-api.example.workers.dev"}}
{"command":"deploy","schemaVersion":1,"env":"staging","pendingMigrations":0,"workers":[{"name":"acme-api","ok":true,"versionId":"<version-id>","url":"https://acme-staging-api.example.workers.dev"}],"kit":null,"kitProblems":null,"dryRun":false}
```

## Errors

Each refusal is a `PithyError`, the problem then the action, and exits by its kind (`docs/CLI.md` §3.8): 2 for a call to fix, 3 for something to set up first. A failed *deploy* is not one of them — it is reported on the rows and exits 1, because the report is the answer, except that a run whose failed Worker row carries `exit` exits with the first such row's `exit`.

- **`No pithy.config.ts here.`** Run it from a Pithy project.
- **`No deployable workers here.`** Nothing under `apps/` carries a `wrangler.jsonc`. Run `pithy worker add <name>`. Exit 3.
- **A Cloudflare account mismatch.** The project pins one account and the resolved credentials belong to another. Refused before wrangler is spawned, naming both ids and which source supplied the wrong one — a file is a local misconfiguration, the environment is a CI job pointed at the wrong tenant. Exit 3.
- **Cloudflare refusing the credentials.** wrangler reports an authentication error (`[code: 10000]` or `[code: 9106]`), or finds no token where nobody can log in. The credentials are the same for every Worker, so on the first Worker the run stops and exits 3, `core/precondition_failed`, with wrangler's lines under `wrangler deploy failed.` and the action `Run pithy doctor to see whether the token or the account is wrong`. It carries no `fix`: a token is minted in the dashboard. Once any Worker has a row — shipped, or failed on its own — a later refusal is that Worker's row instead, with `exit: 3`, so the report keeps every earlier row, and the run exits 3.
- **`Could not run wrangler.`** The program the project runs wrangler with is not on `PATH`. Exit 3, on the same terms as the credentials: it would be every Worker's failure.
- **`<stanza> declares bindings with no Cloudflare resource behind them: <worker>.<BINDING> (<kind>), ….`** Refused before anything is built, for a bare deploy and every `--env`. The action is `pithy provision --env <name> --yes` for a named environment, `pithy provision --feature` for a feature environment, and `--env staging` or `--env prod` for the top-level stanza, whose resources are local to `pithy dev`. For a named or feature environment it is `core/precondition_failed`, exit 3, and that command is its `fix`; for the top-level stanza it is a usage error, exit 2. `--dry-run` refuses the same way, with the same code and `fix`, before it plans anything.
- **`This deploy could create Cloudflare resources, so nothing was deployed.`** A `wrangler deploy` argv without `--experimental-provision=false`, or with a second statement about provisioning. Not reachable from a released CLI — it is the refusal that keeps it that way — and reported on the Worker's row.
- **An environment whose named and served origins do not line up.** Refused before anything is built, naming the Worker, the environment, and the one edit that answers it. See the section above for the three shapes. It is `core/precondition_failed`, exit 3. A declared origin nothing serves, on one Worker, carries `pithy worker sync --worker <worker> --env <env>` as its `fix`, the same one `pithy doctor` names for it; the other shapes are edits and carry none.
- **An environment that does not bind what its Workers declare.** Refused before anything is built, naming the Worker, both sides of the comparison — what the app declares and what the stanza binds — and `pithy worker sync`. It is `core/precondition_failed`, exit 3, and on one Worker its `fix` is `pithy worker sync --worker <worker> --env <env>`, as `pithy doctor` names it.
- **A configuration that is not the requested environment's.** Refused after the build and before the upload, naming the file wrangler was about to ship and both identities — what that file deploys, and what the project declares for the environment asked for. Build the Worker for that environment again; `pithy deploy` does it for you, and the usual cause of a stale one is a hand-run `vite build` with no `CLOUDFLARE_ENV`. Reported per Worker on the row, like a build failure.
- **`<worker> declares rate-limit namespace <id> in <where>. Namespaces 1000000000 through 1999999999 are reserved for features.`** Refused before anything is built. Give that limiter a `namespace_id` below 1000000000.
- **A Worker's build or deploy failing.** Reported per Worker on the row, not thrown. A build failure and a deploy failure read differently, because they have different fixes. wrangler's exit code and stderr are the `error` string.
- **`--kit needs an environment.`** and **`--force needs an environment.`** A kit Worker's configuration is stamped into its vars, so `<project>-staging-email` and `<project>-prod-email` are genuinely separate Workers with no top-level stanza to fall back on. A bare `pithy deploy` is not refused for this. Its kit half says out loud that it needed an environment, and so does `pithy deploy --apps --kit`, which is the same selection. What refuses a bare deploy is a top-level D1 or KV binding with no id, before either half runs — the shape `pithy add` writes one in.
- **`--kit has nothing to deploy in dev.`** and **`--force has nothing to deploy in dev.`** The kit's Workers run locally under `pithy dev` in that environment, so a run narrowed to them would do nothing. `pithy deploy --env dev` is not refused for this, and its kit half says the Workers are local. It meets the same top-level binding refusal as a bare deploy first, though, whenever a binding there has no id.
- **A Worker under `apps/` whose capabilities could not be read.** Reported as its own line beside the kit rows and exits 1 — the capabilities it composes are invisible, so their Workers would silently not ship.
- **`--force has nothing to do with --apps.`** Only the kit's Workers are gated.
- **A kit Worker's deploy failing.** Reported on its row as `failed`, not thrown, so the rest of the set is still attempted.
- **`--env` is validated at the flag** when one is given. `production` is answered with `prod`, exit 2.
- **`--env must be one of staging, prod. Got "qa".`** An environment the root `pithy.config.ts` does not declare, refused before anything is read or built, exit 2. The action names `environments` and one environment the project has. `dev` and `feature` are not declared and are still targets.

## Examples

```bash
# Ship each Worker's top-level stanza. Refused while a binding in it has no id; the kit's Workers need an environment.
pithy deploy

# Ship everything for an environment. Migrate first.
pithy migrate --env prod --json
pithy deploy --env prod --json

# Ship everything, and say where it got to as it goes: a record per step, then the result.
pithy deploy --env prod --json --events

# See what a deploy would do: the plan, then wrangler's own dry run. Nothing is uploaded.
pithy deploy --env prod --dry-run --json

# Your Workers only.
pithy deploy --env prod --apps

# The kit's only, deployed only where something changed.
pithy deploy --env prod --kit

# Re-upload every kit Worker, stamp or not. A recovery run.
pithy deploy --env prod --kit --force

# Your Workers in dev. The kit's run under pithy dev, so none are deployed. Refused, like a bare deploy, while a binding has no id.
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
{"command":"deploy","schemaVersion":1,"env":"prod","pendingMigrations":0,"workers":[{"name":"acme-api","ok":true,"versionId":"<version-id>","url":"https://acme-prod-api.example.workers.dev","verification":"verified","verificationDetail":"https://api.example.com is serving the version just deployed."},{"name":"acme-web","ok":false,"built":false,"error":"vite build failed."}],"kit":[{"capability":"email","worker":"acme-prod-email","outcome":"unchanged","reason":"@pithy-sh/email 0.1.7 is deployed with this configuration."},{"capability":"media","worker":"acme-prod-media","outcome":"deployed","reason":"Its resolved configuration changed."}],"kitProblems":[]}
```

The two environment variables in the CI snippet are the names of secrets your provider holds. No value appears here, and no `pithy deploy` payload can carry one.
