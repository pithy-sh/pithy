# pithy workflow

_The site renders this for readers: [pithy.sh/docs/cli/commands/workflow](https://pithy.sh/docs/cli/commands/workflow). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Start a Workflow by hand, list the Workflows your Workers compose, and follow one instance, in a deployed environment.

## Synopsis

```bash
pithy workflow trigger <job> --env <name> [--worker <name>] [--params <json>] [--id <id>] [--confirm <phrase>] [--dry-run] [--json]
pithy workflow list --env <name> [--worker <name>] [--json]
pithy workflow status <job> <instance> --env <name> [--worker <name>] [--json]
```

## Naming a job

A job is named by its `<capability>/<job>` key: `stats/collect` for a job your app capability `stats` declares, `storage/sweep` for one a kit capability declares. The bare job name works too, `collect`, when exactly one capability the Worker composes declares a job by that name. When two do, the refusal lists both keys to pick from. A name that matches nothing is refused with every key the Worker has.

The job is looked up in the Worker's composed registry, the same one its `scheduled` handler and `c.var.workflows.trigger` start from, so an app job and a kit capability's job are named and started the same way. The deployed Workflow it runs under is `<project>-<env>-<capability>-<job>` (`docs/NAMING.md`), with the Worker's own host in the name when that Worker owns what its capability's host binds: `acme-staging-api---storage-sweep` for an `apps/api` that lists `DB` and `STORAGE_BUCKET` in `ownBindings`. A job with no class of its own, which your Worker hosts from an entry you wrote (`payments/usage`, `auth/purge`, or an optional app job), runs under the name that entry gives its binding in the environment's stanza of `wrangler.jsonc`, and under the owner-less `<project>-<env>-<capability>-<job>` when the stanza has no entry for it. You never type that name; `pithy workflow list` prints it.

## `pithy workflow trigger`

Starts one instance of a job's deployed Workflow, and prints its instance id. It does not wait for the Workflow to finish.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `<job>` | required | The job: its `<capability>/<job>` key, or its bare name |
| `--env <name>` | required | The deployed environment: `staging`, `prod`, or one declared in `pithy.config.ts`. `dev` is refused: there is no deployed Workflow to start |
| `--worker <name>` | the project's only Worker | The Worker that composes the job. Required when the project has more than one |
| `--params <json>` | `{}` | The instance's params, as one JSON value: `'{"backfill":true}'`. Parsed through the job's own `params` schema first, so a schema with defaults fills in what you leave out |
| `--id <id>` | the job's `instanceId`, else Cloudflare's | Name the instance: 1 to 100 letters, digits, dashes or underscores |
| `--confirm <phrase>` | none | Unlock a production environment without a prompt: `"yes, i really want to trigger <env>"` |
| `--dry-run` | `false` | Resolve, validate and print what would start, without starting it |
| `--json` | `false` | Machine-readable output — one JSON line |

### What it checks before anything is sent

`--params` is parsed as JSON and then through the job's `params` schema, before any network call. A value the Workflow would refuse is refused here, `validation/invalid_input`, with the schema's message naming each field: `--params does not fit stats/collect: backfill: Invalid input: expected boolean, received string.` `--id` is held to Cloudflare's rule for an instance id the same way.

### Instance ids

The id an instance starts under is `--id`, else the job's spec `instanceId` (called with the time now and the parsed params), else none, and Cloudflare generates one. A Workflow holds one instance per id, so an id that is taken is refused, `core/conflict`, with the `pithy workflow status` line that follows the instance already holding it. A job whose `instanceId` names its instances by day therefore runs once per day by hand as on its schedule; pass `--id` to run it again.

### Production

A production environment — `prod`, `production`, or any name in `seed.productionEnvironments` — needs the exact phrase `yes, i really want to trigger <env>`, compared case-insensitively. At a terminal it is asked for. A run that may not prompt (`--json`, `--no-input`, `PITHY_NONINTERACTIVE=1`, or no terminal) needs `--confirm` with the phrase, and without it is refused `core/person_required`, exit 5, before anything is sent (`docs/CLI.md` §3.8). The phrase is a person's to give: an agent that meets the refusal stops and asks. Any other environment starts without asking. `--dry-run` asks for nothing.

### `--dry-run`

Resolves the job, the Worker and the Workflow name, validates `--params` and `--id`, and starts nothing. With an id, from `--id` or the job's `instanceId`, it also asks Cloudflare whether that id is taken, and refuses it as the real run would. It reads the project's Cloudflare credentials either way. Under `--json` the payload carries `plan` (below).

### `--json`

One line on stdout.

| key | type | meaning |
|---|---|---|
| `command` | string | `"workflow trigger"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `env` | string | The environment the Workflow runs in. |
| `worker` | string | The Worker that composes the job, by its `apps/` directory. |
| `job` | string | The job's `<capability>/<job>` key, whichever spelling was typed. |
| `workflow` | string | The deployed Workflow the instance runs under. |
| `instanceId` | string \| null | The instance id. `null` only under `--dry-run` when Cloudflare would pick it. |
| `dryRun` | boolean | Whether this was `--dry-run`. Nothing was started when it is `true`. |
| `plan` | object | Present only under `--dry-run`, in the shape every `--dry-run` shares (`docs/CLI.md` §1.2): one `write` under `data` with `store: "workflow"` and the Workflow as its `target`, and a note naming the instance id, or saying Cloudflare picks it. |

## `pithy workflow list`

Lists every job each Worker composes, with its deployed Workflow name in the environment and its schedule. It reads the project only and never reaches Cloudflare, so it says what the composition declares, not what is deployed.

| Flag | Default | Purpose |
|---|---|---|
| `--env <name>` | required | The environment the Workflow names are for |
| `--worker <name>` | every Worker | List one Worker's jobs |
| `--json` | `false` | Machine-readable output — one JSON line |

One line per job, Worker by Worker and each Worker's jobs by key: the Worker, the key, the Workflow, and `cron <expression>` or `on trigger`. A project with no Workflow prints `No Worker composes a Workflow.`

### `--json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"workflow list"`. |
| `schemaVersion` | integer | The version of this payload's shape. |
| `env` | string | The environment the Workflow names are for. |
| `jobs` | object[] | Every job each Worker composes, Worker by Worker. Empty when none does. |
| `jobs[].worker` | string | The Worker that composes it, by its `apps/` directory. |
| `jobs[].key` | string | The job's `<capability>/<job>` key. |
| `jobs[].capability` | string | The capability that declares it: a kit capability, or the Worker's app. |
| `jobs[].job` | string | The job name. |
| `jobs[].binding` | string | The Workflow binding the Worker reaches it by. |
| `jobs[].schedule` | string \| null | Its cron, or `null` for a job that runs only when triggered. |
| `jobs[].workflow` | string | Its deployed Workflow name in the environment. |

## `pithy workflow status`

Reports one instance: its state, its output once it completes, and why it failed when it did.

| Flag | Default | Purpose |
|---|---|---|
| `<job>` | required | The job: its `<capability>/<job>` key, or its bare name |
| `<instance>` | required | The instance id the trigger printed |
| `--env <name>` | required | The environment the instance runs in |
| `--worker <name>` | the project's only Worker | The Worker that composes the job |
| `--json` | `false` | Machine-readable output — one JSON line |

The first line is `<key> <instance> in <env>: <status>.` A failure adds `Step <name> failed: <reason>`, or `Failed: <reason>` when no step is named, and a completed instance adds `Output: <json>`. The command reports the state and exits 0 whatever it is: an `errored` instance is an answer, not a failed call.

### `--json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"workflow status"`. |
| `schemaVersion` | integer | The version of this payload's shape. |
| `env` | string | The environment the Workflow runs in. |
| `worker` | string | The Worker that composes the job, by its `apps/` directory. |
| `job` | string | The job's `<capability>/<job>` key. |
| `workflow` | string | The deployed Workflow the instance runs under. |
| `instanceId` | string | The instance id. |
| `status` | string | The instance's lifecycle state, as Cloudflare reports it: `queued`, `running`, `paused`, `waiting`, `complete`, `errored`, `terminated` and the rest of its set. |
| `output` | any | The Workflow's return value. Present once `status` is `complete`. |
| `error` | string \| null | Why it failed: the failed step's text, else the instance's own. `null` when nothing failed. |
| `failedStep` | string \| null | The name of the step that failed. `null` when none did. |

## Errors

Each exits by its kind (`docs/CLI.md` §3.8).

| Condition | Effect |
|---|---|
| No `--env`, `dev`, or an environment the project does not declare | Refused `validation/invalid_input`, exit 2, naming the environments it takes. |
| A job name that matches nothing, or a bare name two capabilities declare | Refused `validation/invalid_input`, exit 2, listing the keys to pick from. |
| `--params` that is not JSON, or does not fit the job's schema | Refused `validation/invalid_input`, exit 2, with the schema's message, before any network call. |
| `--id` outside Cloudflare's rule | Refused `validation/invalid_input`, exit 2. |
| An id the Workflow already holds | Refused `core/conflict`, exit 3, with the `pithy workflow status` line for that instance. Under `--dry-run` too. |
| A production environment without the phrase | Refused `core/person_required`, exit 5, naming `--confirm`. |
| `status` for an instance id the Workflow does not hold | Refused `core/not_found`, exit 3. Check the id and the `--env` it ran in. |
| `Cloudflare credentials are missing.` | Exit 3, on `trigger` and `status`. Run `pithy cloudflare connect`, or set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. |

## Examples

```bash
# Backfill: start the app's collector with params its schema accepts.
pithy workflow trigger stats/collect --env staging --params '{"backfill":true}' --id backfill-1

# Follow the instance it started.
pithy workflow status stats/collect backfill-1 --env staging

# What would start in production, and under which Workflow.
pithy workflow trigger collect --env prod --dry-run --json
```

```text
Started stats/collect in staging, as acme-staging-stats-collect.
Instance backfill-1. Follow it with pithy workflow status stats/collect backfill-1 --env staging --worker api.
Done.
```

```text
api  stats/collect  acme-staging-stats-collect  cron 0 * * * *
api  storage/sweep  acme-staging-storage-sweep  on trigger
```

```json
{"command":"workflow trigger","schemaVersion":1,"env":"staging","worker":"api","job":"stats/collect","workflow":"acme-staging-stats-collect","instanceId":"backfill-1","dryRun":false}
```

Canceling, pausing or retrying an instance is not here; `wrangler workflows instances` does those against the Workflow name `pithy workflow list` prints.
