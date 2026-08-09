# pithy provision

Create a declared environment's own Cloudflare resources, wire them into every Worker, and migrate.

## Synopsis

```
pithy provision --env <environment> [--yes] [--confirm <phrase>] [--seed] [--json]
```

Run it from the project root. `--env` names one of the environments the root `pithy.config.ts` declares; anything else is refused, naming the set the project does have.

## Why it exists

A project scaffolded, wired and migrated by pithy could not be deployed, and nothing said why.

```
pithy add <cap>          runs the Worker's dev migrations — local D1 through Miniflare.
                         Creates nothing remote.
pithy migrate --env prod queries the target database. Assumes it exists.
pithy deploy             provisions nothing. Spawns wrangler.
```

So `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way — and the first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in.

`pithy feature provision` had always done exactly this job for a branch's ephemeral environment. This is the same step for the environments a project ships to, under the naming those environments want.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--env <environment>` | required | The declared environment to provision. Refused unless the root `pithy.config.ts` lists it |
| `--yes` | `false` | Confirm that this creates real Cloudflare resources. Required for every environment |
| `--confirm <phrase>` | — | Unlock a production environment non-interactively: `yes, i really want to provision <env>` |
| `--seed` | `false` | Also load seed fixtures once the schema is up |
| `--json` | `false` | One line of machine-readable output |

## What it does

1. **Resolves the scope.** The environment and the resource naming come from one object, never two arguments: names are `<project>-<env>-<thing>`, and the stanza they are written into is that same `<env>`. That is what makes a name whose environment segment disagrees with the stanza it lives in unexpressible rather than merely discouraged.
2. **Provisions one resource per binding name**, across the union of every Worker's capabilities. Two Workers that both declare `DB` share one database; a Worker that wants its own declares a different binding.
3. **Adopts rather than duplicates.** Every resource is matched by name before it is created, so a re-run is a no-op and a database an adopter made by hand under the right name is taken up rather than shadowed by a second one.
4. **Writes the ids into each Worker's own `wrangler.jsonc`**, under `env.<name>` — and a Worker receives only the bindings its own config declares. The D1 entry gets its `database_name` alongside its `database_id`, because `pithy add` proposes the name offline and this is the step that makes the proposal true. The stanza is created when it is absent, so an environment declared after the project was scaffolded needs no hand-editing.
5. **Retargets `service` bindings** at this environment's copy of the callee, resolved through each Worker's real deploy name rather than its `apps/<name>` directory.
6. **Migrates.** Seeding is off unless `--seed` is passed: a declared environment already holds real rows, and seeding one is `pithy seed`'s job, with its own gate.

**These ids are source, not a build artifact.** They are long-lived and they belong in a pull request where a human reads them — which is the difference between this command and `pithy feature provision`, whose per-branch config is written to a git-ignored file and never committed.

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

There is none, deliberately. `pithy feature destroy` reverses a branch's environment because a branch's environment is disposable. Staging and production are not, and the one-word difference between the two is not a difference a flag should carry. Delete them in Cloudflare, by hand, on purpose.

## `--json`

```
$ pithy provision --env staging --yes --json
{"command":"provision","env":"staging","resources":[{"kind":"d1","binding":"DB","name":"replay-staging-db","id":"9f0…","created":true}],"workers":[{"worker":"replay-board","name":"replay-board-staging"}],"services":[]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"provision"` | The command that produced the line |
| `env` | `string` | The environment provisioned |
| `resources` | `object[]` | Every resource, in provision order |
| `resources[].kind` | `"d1" \| "kv" \| "r2"` | The Cloudflare resource type |
| `resources[].binding` | `string` | The Worker binding this resource backs, e.g. `DB` |
| `resources[].name` | `string` | The full Cloudflare resource name, `<project>-<env>-<thing>` |
| `resources[].id` | `string` | The Cloudflare-assigned id — a D1 uuid, a KV namespace id, or the bucket name for R2 |
| `resources[].created` | `boolean` | True when this run created it; false when a resource of that name already existed and was adopted |
| `workers` | `object[]` | Each Worker and the script name it deploys under in this environment |
| `workers[].worker` | `string` | The Worker's own deploy name — its `wrangler.jsonc` `name` |
| `workers[].name` | `string` | The environment-scoped script name written into `env.<name>` |
| `services` | `object[]` | Each `service` binding and the Worker it now targets in this environment |
| `services[].binding` | `string` | The binding name |
| `services[].service` | `string` | The script the binding was retargeted at |

## Exit codes

`0` on success. Non-zero with a one-line problem and an action for a missing declaration, missing credentials, an unconfirmed production run, or a `service` binding naming a Worker this project does not have — which is refused before a single resource is created.

## See also

- [`feature.md`](feature.md) — the same step for a branch's ephemeral environment
- [`deploy.md`](deploy.md) — what refuses when this has not been run
- `docs/NAMING.md` — the `<project>-<env>-<thing>` rule and its character budget
