# pithy provision

Create an environment's own Cloudflare resources, wire them into every Worker, and migrate.

## Synopsis

```
pithy provision --env <environment> [--yes] [--confirm <phrase>] [--seed] [--json]
pithy provision --feature [--json]
```

One job, two spellings. `--env` provisions an environment the root `pithy.config.ts` declares; `--feature` provisions the one this branch gets. **Exactly one of them is required**, and passing both is refused at the flag, before a config is loaded or a Cloudflare client is built.

`--env` runs from the project root. `--feature` runs from inside the feature worktree, and takes no name: the branch says which feature it is.

## Why one command

Both modes create one Cloudflare resource per binding name across every Worker, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in `pithy.config.ts`, or derived from the branch. That is a flag, not a different verb.

They were two commands because the naming and the destination stanza used to be independent arguments, and the combination was a real hazard: `pithy feature provision --env staging` composed `<project>-f<issue>-<slug>-db` and wrote it into staging's stanza of a checked-in config, then migrated against it. `ProvisionScope` fused the two into one value — a scope carries both the names and the stanza — so that combination is now unexpressible rather than merely refused. The safety no longer depends on which command was typed, and two verbs for one job is not what reads best.

## The one real difference: what happens to the ids

| | writes | status |
|---|---|---|
| `--env <name>` | `env.<name>` in the Worker's tracked `wrangler.jsonc` | **source** — long-lived ids a human reviews in a pull request |
| `--feature` | `apps/<worker>/.wrangler/pithy/wrangler.feature.jsonc` | **build artifact** — git-ignored, rebuilt every run, never committed |

A single flag that flips whether output is committed will eventually surprise someone, so **every run states the file it wrote and what happens to it**:

```
Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
```

`--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than inferring it. This is also what keeps the standing rule true: **a CI build process never commits back to the repository.** A pipeline runs `--feature` and has nothing to commit; a human runs `--env` and commits ids in a pull request.

## `--feature` is explicit, never inferred

It is not derived from "the branch looks like a feature branch". An implicit mode switch on branch shape is how someone on `feature/…` provisions the wrong thing while reading a command line that says nothing about it. The flag is the declaration; the branch is only where a feature's *name* comes from once you have made it.

The two modes cannot reach each other's environment either. `--feature` writes the `feature` stanza and nothing else. `--env` accepts only what the project declares, and `feature` can never be declared — it is a legal wrangler stanza key and an illegal declaration, because a feature's config is generated rather than committed, and one stanza cannot have two owners.

## Why it exists at all

A project scaffolded, wired and migrated by pithy could not be deployed, and nothing said why.

```
pithy add <cap>          runs the Worker's dev migrations — local D1 through Miniflare.
                         Creates nothing remote.
pithy migrate --env prod queries the target database. Assumes it exists.
pithy deploy             provisions nothing. Spawns wrangler.
```

So `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way — and the first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in. The provisioner was never missing; only the command and the naming were.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--env <environment>` | — | — | The declared environment to provision. Refused unless the root `pithy.config.ts` lists it |
| `--feature` | — | `false` | Provision this branch's own environment instead. Run from inside the worktree |
| `--yes` | `--env` | `false` | Confirm that this creates real Cloudflare resources. Required for every declared environment |
| `--confirm <phrase>` | `--env` | — | Unlock a production environment non-interactively: `yes, i really want to provision <env>` |
| `--seed` | `--env` | `false` | Also load seed fixtures once the schema is up |
| `--json` | both | `false` | One line of machine-readable output |

`--yes`, `--confirm` and `--seed` say nothing a feature environment does not already do. It is created per pull request and destroyed on merge, so there is nothing to confirm — a gate every pipeline has to pass is a gate that has stopped meaning anything — and it is created empty, so it always seeds.

## What it does

1. **Resolves the scope.** The naming and the stanza come from one object, never two arguments: `<project>-<env>-<thing>` into `env.<env>` for a declared environment, `<project>-f<issue>-<slug>-<thing>` into `env.feature` for a branch's. That is what makes a name whose environment segment disagrees with the stanza it lives in unexpressible rather than merely discouraged.
2. **Provisions one resource per binding name**, across the union of every Worker's capabilities. Two Workers that both declare `DB` share one database; a Worker that wants its own declares a different binding.
3. **Adopts rather than duplicates.** Every resource is matched by name before it is created, so a re-run is a no-op and a database an adopter made by hand under the right name is taken up rather than shadowed by a second one.
4. **Writes the ids into each Worker's config**, under `env.<name>` — and a Worker receives only the bindings its own config declares. The D1 entry gets its `database_name` alongside its `database_id`, because `pithy add` proposes the name offline and this is the step that makes the proposal true. The stanza is created when it is absent, so an environment declared after the project was scaffolded needs no hand-editing.
5. **Writes the `secrets_store_secrets` stanza** for every `cf-secrets-store` secret the Worker's own registry declares, when a Secrets Store id is in hand. `pithy add` deliberately could not write it — the entry needs a `store_id` and a `secret_name` that do not exist until an account has been reached — so a Worker deployed without `SECRETS_ENCRYPTION_KEYS` and failed at its first request. A declared secret whose entry has not been created is reported rather than bound: wrangler refuses a config naming an absent entry, so binding it would turn one missing value into a failed deploy of the whole Worker.
6. **Retargets `service` bindings** at this environment's copy of the callee, resolved through each Worker's real deploy name rather than its `apps/<name>` directory.
7. **Migrates**, and seeds when asked. A feature also mints its own master key and records a manifest so `pithy feature destroy` deletes exactly what was created — the two things a declared environment has no equivalent of, which are [`feature.md`](feature.md)'s subject.

## Production

`--yes` is not enough for production, and never becomes enough. A production environment — the built-in `prod`/`production`, plus anything the project declares in `seed.productionEnvironments` — additionally requires the exact phrase:

```
pithy provision --env prod --yes --confirm "yes, i really want to provision prod"
```

The phrase names its environment, so one typed for `staging` cannot be pasted into a command targeting `prod`. Interactively the CLI asks for it; under `--json` it must arrive by flag, so a headless production provision happens only when a human wrote the phrase into the pipeline.

## Deploy refuses, it does not provision

`pithy deploy --env staging` checks first, and refuses with the command to run when a binding has no resource behind it:

```
staging declares bindings with no Cloudflare resource behind them: board.DB (d1).
Run pithy provision --env staging --yes, then deploy.
```

A deploy that silently created account resources would be hard to review, and these are the resources worth reviewing. `pithy doctor` reports the same state without being asked.

## Teardown

`pithy feature destroy` reverses a branch's environment, because a branch's environment is disposable.

For a declared environment there is none, deliberately. Staging and production are not disposable, and the one-word difference between the two is not a difference a flag should carry. Delete them in Cloudflare, by hand, on purpose.

## `pithy feature provision` (deprecated)

The old spelling still works. It prints the new one and runs it:

```
$ pithy feature provision
pithy feature provision is now pithy provision --feature. Running it.
```

The notice goes to stderr, so `--json` still writes exactly one line to stdout — and that line carries `"command":"provision"`, because that is the command it ran.

## `--json`

```
$ pithy provision --env staging --yes --json
{"command":"provision","env":"staging","resources":[{"kind":"d1","binding":"DB","name":"replay-staging-db","id":"9f0…","created":true}],"workers":[{"worker":"replay-board","name":"replay-board-staging"}],"services":[],"secretBindings":[],"configs":[{"worker":"replay-board","path":"apps/board/wrangler.jsonc","ids":3}],"committed":true}
```

```
$ pithy provision --feature --json
{"command":"provision","env":"feature","resources":[{"kind":"d1","binding":"DB","name":"replay-f251-one-command-db-d1","id":"3c1…","created":true}],"workers":[{"worker":"replay-board","name":"replay-f251-one-command-replay-board"}],"services":[],"secretBindings":[],"configs":[{"worker":"replay-board","path":"apps/board/.wrangler/pithy/wrangler.feature.jsonc","ids":3}],"committed":false}
```

| key | type | meaning |
|---|---|---|
| `command` | `"provision"` | The command that produced the line. The same for both modes, and for the deprecated alias |
| `env` | `string` | The environment provisioned — a declared name, or `feature` |
| `resources` | `object[]` | Every resource, in provision order |
| `resources[].kind` | `"d1" \| "kv" \| "r2"` | The Cloudflare resource type |
| `resources[].binding` | `string` | The Worker binding this resource backs, e.g. `DB` |
| `resources[].name` | `string` | The full Cloudflare resource name |
| `resources[].id` | `string` | The Cloudflare-assigned id — a D1 uuid, a KV namespace id, or the bucket name for R2 |
| `resources[].created` | `boolean` | True when this run created it; false when a resource of that name already existed and was adopted |
| `workers` | `object[]` | Each Worker and the script name it deploys under in this environment |
| `workers[].worker` | `string` | The Worker's own deploy name — its `wrangler.jsonc` `name` |
| `workers[].name` | `string` | The scoped script name written into `env.<name>` |
| `services` | `object[]` | Each `service` binding and the Worker it now targets in this environment |
| `services[].binding` | `string` | The binding name |
| `services[].service` | `string` | The script the binding was retargeted at |
| `secretBindings` | `object[]` | Every `cf-secrets-store` secret this environment declares |
| `secretBindings[].binding` | `string` | The Worker binding name, which is the registry key |
| `secretBindings[].entry` | `string` | The Secrets Store entry it resolves to in this environment |
| `secretBindings[].bound` | `boolean` | True when the entry exists and the binding was written. False when the secret is declared and its entry has never been created — binding it anyway would make wrangler refuse the whole config |
| `configs` | `object[]` | Where the ids were written, one entry per Worker |
| `configs[].worker` | `string` | The Worker's own deploy name |
| `configs[].path` | `string` | The file written, relative to the project root |
| `configs[].ids` | `number` | How many binding ids landed in it |
| `committed` | `boolean` | Whether those files are committed. `true` for `--env`, `false` for `--feature` — the one field a pipeline reads to know it has nothing to commit |

## Exit codes

`0` on success. Non-zero with a one-line problem and an action for: no mode or both modes, a missing declaration, missing credentials, a branch that is not a feature branch, an unconfirmed production run, or a `service` binding naming a Worker this project does not have — which is refused before a single resource is created.

## See also

- [`feature.md`](feature.md) — the rest of a branch's lifecycle: `create`, `sync`, `destroy`
- [`deploy.md`](deploy.md) — what refuses when this has not been run
- `docs/NAMING.md` — the `<project>-<env>-<thing>` rule and its character budget
