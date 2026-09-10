# pithy payments

_The site renders this for readers: [pithy.sh/docs/cli/commands/payments](https://pithy.sh/docs/cli/commands/payments). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Deploy the reconciliation Workflow that keeps stored purchases agreeing with the stores, and run a pass on demand.

## Synopsis

```
pithy payments provision [--worker <name>] [--json]
pithy payments reconcile [--env <environment>] [--subject <holder>] [--rail <rail>] [--dry-run] [--json]
```

**Its Worker deploy is gated.** The Worker is deployed carrying a stamp naming the package version and a hash of its resolved configuration, and a run whose stamp matches both ships nothing. Anything the gate cannot establish — no Worker, no stamp, an unreachable account — deploys. `pithy deploy --env <env>` ships the same Worker without provisioning anything else, and `pithy deploy --env <env> --kit --force` re-uploads it regardless. See [`pithy deploy`](./deploy.md).

**Both subcommands need a Cloudflare account.** `provision` deploys a Worker per managed environment; `reconcile` dispatches a Workflow into an already-deployed one. Neither has a local path — `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are checked before anything runs, and `provision` additionally requires `SECRETS_STORE_ID`.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--env <environment>` | `reconcile` | `staging` | Which deployed environment to run the pass in. `staging` or `prod` — `dev` is local-only and is refused by name |
| `--subject <holder>` | `reconcile` | every holder | Reconcile one holder's purchases, as `user:<id>` or `organization:<id>`. The support path: the same steps the cron runs, narrowed. An id on its own is refused — it names whichever user *or* organization carries it |
| `--rail <rail>` | `reconcile` | every rail | Reconcile one rail: `apple`, `google`, `stripe`, `lemonSqueezy`, or `paddle`. Parsed here, so a mistyped rail is a sentence in this terminal rather than a Workflow that burns its retry budget unwatched |
| `--worker <name>` | `provision` | the project's only Worker | The app Worker whose `wrangler.jsonc` carries the per-environment `DB` binding and receives the `PAYMENTS_RECONCILE` binding. Required when a project has several |
| `--dry-run` | `reconcile` | `false` | Report the drift and write nothing |
| `--json` | both | `false` | One line of machine-readable output |

`provision` takes no `--env`. It spans every managed environment in one run, and **skips the ones whose app database does not exist yet** rather than refusing: the answer to "which environments did you mean" is always *the ones that are ready*, so there is nothing to state on the command line.

## What it does

`pithy add payments` writes bindings and touches no Cloudflare account. `provision` stands up the one thing those bindings point at: the prebuilt reconcile Worker that hosts the nightly pass. For each **ready** environment it checks the account once up front, deploys the Worker, and then writes that environment's `workflows` binding into the app's `wrangler.jsonc`.

An environment is **ready** when its stanza in the app's `wrangler.jsonc` carries a `DB` binding with a `database_id` — that is, when `pithy provision --env <name>` has run for it. One that is not is **skipped and reported**, never fatal: standing staging up and proving it before production resources exist is the ordinary bring-up, and this command used to refuse it part way through, naming production. The decision is made once, from one read, before a single deploy. The binding cannot be written by `add` — wrangler requires a `name` and a `class_name` on every entry, and the deployed name is per environment (`<project>-<env>-payments-reconcile`), so `add` emits none and this completes it.

**No credential is written here, and that is not an omission.** Apple's `.p8`, Google's service-account key, Stripe's key pair, and Lemon Squeezy's and Paddle's API keys are taken by a human from five consoles; nothing can mint them. They go in through `pithy secrets create payments-provider-credentials`, and this command deploys the Worker that reads them. A `provision` run before the secrets are set still succeeds — the first pass is what reports the missing rail.

### Where each rail's credentials come from

`payments-provider-credentials` is one secret with a block per rail, and each block is issued by a different company. This is the table its `documentation` link exists to reach — the console, not the integration guide.

| Rail | Console | What to take |
|---|---|---|
| `apple` | <https://appstoreconnect.apple.com/access/integrations/api> | The App Store Connect API key. Download the `.p8` — it is offered exactly once — and copy the key id and the issuer id from the same screen |
| `google` | <https://console.cloud.google.com/iam-admin/serviceaccounts> | The service account and a JSON key for it. Grant that account access to the app in Play Console; the key itself is minted here |
| `stripe` | <https://dashboard.stripe.com/apikeys> | The secret key. The webhook signing secret is per endpoint, one screen across under Developers → Webhooks |
| `lemonSqueezy` | <https://app.lemonsqueezy.com/settings/api> | The API key, and the signing secret of the webhook you point at this project |
| `paddle` | <https://vendors.paddle.com/authentication-v2> | The API key, and the notification destination's signing secret. Not the client token — that is publishable and belongs in `pithy.config.ts` |

Each console is per environment on its own terms: Stripe's test mode, Paddle's and Lemon Squeezy's sandboxes, Apple's and Google's separate keys. Provision `staging` and `prod` from the matching one, never the same credential twice.

**These are also where a credential is replaced.** Rotation is `manual` for this secret because none of the five returns a new value over an API — a human opens the console, mints the replacement, and sets it. `rotatable: true` means the store holds both versions while webhooks signed under the old one drain.

`reconcile` runs that same pass on demand and waits for its report. It dispatches the deployed Workflow, polls until it reaches a terminal state, and prints what it found. Reconciliation is the repair path, never the primary one: a rising `drifted` count means webhooks are not arriving, which is the signal the command exists to surface.

## `--json`

One line, one object, one shape per subcommand. The `command` field carries the space-separated form (`payments provision`), not the dotted one.

```
$ pithy payments provision --json
{"command":"payments provision","environments":["staging"],"skippedEnvironments":[{"env":"prod","reason":"env.prod has no DB database_id.","action":"Run pithy provision --env prod."}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"payments provision"` | The subcommand that produced the line |
| `environments` | `string[]` | Every environment a reconcile worker was deployed for, in order. `dev` is local-only and never a deploy target |
| `skippedEnvironments` | `object[]` | One entry per environment nothing was provisioned for |
| `skippedEnvironments[].env` | `string` | The environment that was skipped |
| `skippedEnvironments[].reason` | `string` | Why — `env.<name> has no DB database_id.` |
| `skippedEnvironments[].action` | `string` | The command that resolves it |

When **every** environment was skipped the line above is still written to stdout — the per-environment structure is the answer, and losing it to the error line would make `--json` less use than the text — and an `{"error":…}` line follows on stderr with exit 1.

```
$ pithy payments reconcile --env staging --json
{"command":"payments reconcile","env":"staging","report":{"pages":3,"scanned":214,"unchanged":198,"drifted":4,"superseded":11,"skipped":1,"failed":0,"truncated":false,"dryRun":false}}
```

| key | type | meaning |
|---|---|---|
| `command` | `"payments reconcile"` | The subcommand that produced the line |
| `env` | `string` | The environment the pass ran in |
| `report` | `object` | The Workflow's own return value, passed through verbatim |

**`report` is the deployed Workflow's output, not the CLI's.** It crosses no schema on the way out — the Workflows client types it `unknown` and this command passes it straight through. It is absent from the line entirely when a completed Workflow returned nothing. What `@pithy-sh/payments` returns today is:

| `report` key | type | meaning |
|---|---|---|
| `pages` | `number` | Pages read — one durable step each |
| `scanned` | `number` | Purchases examined |
| `unchanged` | `number` | Purchases whose stored state already matched the store's |
| `drifted` | `number` | Purchases whose stored state disagreed. The number that matters: a rising one means webhooks are lost |
| `superseded` | `number` | Purchases a later period of the same subscription has replaced, settled on this pass |
| `skipped` | `number` | Purchases no store could be asked about |
| `failed` | `number` | Purchases a store refused to answer for. Counted, never thrown — one bad row must not end the pass |
| `truncated` | `boolean` | Whether the run stopped at its page cap with more of the catalog unexamined |
| `dryRun` | `boolean` | Whether the run only reported |

## Errors

Each one is a `PithyError` — the problem, then the action. Under `--json` they arrive on stderr as `{"error":{…}}`, and the process exits 1.

**The capability is not configured.** No Worker under `apps/` composes `payments`.

```
The payments capability is not configured.
Add `payments({ rails: { ... }, products: { ... } })` to pithy.config.ts (run `pithy add payments`).
```

**Cloudflare credentials are missing.** Raised before any client is built.

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**The Secrets Store id is missing.** `provision` only — the reconcile Worker decrypts each rail's credentials from it.

```
The CF Secrets Store id is missing.
Run pithy add secrets to record SECRETS_STORE_ID (the reconcile worker decrypts the rails' credentials from it).
```

**`--env dev`.** Checked at the flag, before a single Cloudflare client exists.

```
--env must be one of staging, prod. Got "dev".
This deploys to a Cloudflare account, and dev is local-only. Run `pithy dev` instead.
```

**No environment is ready.** Every declared environment was skipped, so nothing was deployed and the run exits 1: `No environment is ready — staging and prod have no DB database_id.` A run where some environment was ready exits 0 and reports the rest as skipped.

**The environment has no wrangler stanza at all.** `api's wrangler.jsonc has no env.<env> stanza.` — config drift rather than provisioning state, so it is refused rather than skipped; `pithy provision --env <name>` does not write a stanza.

**The environment's secrets database does not exist.** `The <env> secrets database (<name>) does not exist.` Run `pithy secrets provision` first.

**The project has no name.** Every deployed name leads with it, and it is never guessed: a wrong one dispatches into a Workflow nothing deployed.

**The Workflow did not finish.** `reconcile` polls a dispatched instance and raises a `cloudflare/*` error when it ends `errored` or `terminated`, or when it is still running at the poll cap.

## Examples

Stand the reconcile Worker up across every managed environment.

```
$ pithy payments provision
  staging  reconcile worker deployed, PAYMENTS_RECONCILE bound
  prod     skipped — env.prod has no DB database_id. Run pithy provision --env prod.
Set each rail's credentials with `pithy secrets create payments-provider-credentials` — nothing can mint them.
Done.
```

Answer "my subscription isn't showing up" for one person, through the steps the cron runs.

```
$ pithy payments reconcile --env prod --subject user:usr_a1b2c3
```

See what a pass would repair, without repairing it.

```
$ pithy payments reconcile --env staging --dry-run
```

Run one rail after that store's webhooks were interrupted, rather than paying for the other two.

```
$ pithy payments reconcile --env prod --rail stripe --json
```
