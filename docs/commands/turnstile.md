# pithy turnstile

_The site renders this for readers: [pithy.sh/docs/cli/commands/turnstile](https://pithy.sh/docs/cli/commands/turnstile). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Wire Cloudflare's Turnstile test keys into dev and staging, provision the real production widget, and tear it back down.

## Synopsis

```
pithy turnstile provision [--worker <name>] [--allow-shared-domain] [--json]
pithy turnstile deprovision [--worker <name>] [--json]
```

**Both subcommands need a Cloudflare account.** A production widget is an account resource, and its secret is written to a managed store through a deployed dispatcher. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are checked before anything is created.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--worker <name>` | both | the project's only Worker | The web-facing Worker whose `wrangler.jsonc` holds the production address and the per-environment sitekey vars. Required when the project has several |
| `--allow-shared-domain` | `provision` | `false` | Provision even though another Turnstile widget already covers the domain |
| `--json` | both | `false` | One line of machine-readable output |

There is no `--env`. A widget binds to the domain a human loads it on, so `prod` is not a parameter: the production hostname is resolved from the target Worker, and dev and staging get Cloudflare's documented test keys either way.

There is no `--mode`. Which widgets exist is declared in the Worker's `pithy.config.ts` under `turnstile({ widgets })`, and a flag would be a second source of truth that drifts the moment someone enables one in config.

## What it does

`provision` reads the enabled widget modes from config — `visible`, `invisible`, or both — and resolves the production hostname through the one address resolver: the Worker's `domains` declaration for `prod`, else its `env.prod` route, else a hand-set `vars.BASE_URL`. It then does three things per mode. **dev and staging** get Cloudflare's documented test secret, written per environment — dev to `.dev.vars`, staging to its managed store. **`prod`** gets a real widget bound to that hostname, its secret written to the production managed store, and its public sitekey written to the production Worker vars.

**A test key belongs in those two environments and nowhere else, and the gate enforces that.** Cloudflare flags its own answers from a documented test key (`metadata.result_with_testing_key`), so a Worker stamped `prod` — or stamped nothing — refuses one with `turnstile/config` rather than letting a secret that passes everybody stand in for a widget. It is the same flag that lets dev and staging sign in at all: a test key's answer carries no `action`, which the login gate's action binding would otherwise refuse (#374). See [pithy.sh/docs/capabilities/turnstile/reference](https://pithy.sh/docs/capabilities/turnstile/reference).

Idempotent: a re-run reuses an existing production widget rather than creating a second one. That reuse has one consequence worth stating, because it is the failure adopters hit. Cloudflare never returns an existing widget's secret, so it cannot be recomposed — a re-run over widgets that already exist leaves the stored secret exactly as it was, and reports that it did. If the secret was never stored, re-running will not heal it; `deprovision` then `provision` is what does.

`--allow-shared-domain` is the escape hatch for the one legitimate case: an adopter already running a hand-made widget on that host who is not ready to retire it. Off by default, because the refusal is the useful answer.

`deprovision` deletes the production widget for each declared mode, deletes the managed secret, clears the turnstile values from `.dev.vars`, and clears the sitekey vars from the deployed environments. It is the inverse of `provision` and the first half of the repair for a lost production secret.

## `--json`

One line, one object, one shape per subcommand. The `command` field carries the space-separated form (`turnstile provision`), not the dotted one.

```
$ pithy turnstile provision --json
{"command":"turnstile provision","modes":["visible"],"widgets":[{"mode":"visible","sitekey":"0x4AAA…","created":true}],"productionSecretWritten":true}
```

| key | type | meaning |
|---|---|---|
| `command` | `"turnstile provision"` | The subcommand that produced the line |
| `modes` | `("visible" \| "invisible")[]` | The widget modes the config declares, and that this run acted on |
| `widgets` | `object[]` | One entry per production widget — see below |
| `widgets[].mode` | `"visible" \| "invisible"` | Which widget this entry is |
| `widgets[].sitekey` | `string` | The production public sitekey. Public by definition: the front end renders the widget with it |
| `widgets[].created` | `boolean` | True when this run created the widget; false on idempotent reuse |
| `productionSecretWritten` | `boolean` | Whether the production secret was written this run. False when every widget already existed — Cloudflare never returns an existing widget's secret, so it could not be recomposed and was left as it was |

```
$ pithy turnstile deprovision --json
{"command":"turnstile deprovision","modes":["visible","invisible"]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"turnstile deprovision"` | The subcommand that produced the line |
| `modes` | `("visible" \| "invisible")[]` | The widget modes torn down |

## Errors

Each one is a `PithyError` — the problem, then the action. Under `--json` they arrive on stderr as `{"error":{…}}`, and the process exits 1.

**The capability is not configured.** No Worker under `apps/` composes `turnstile`.

```
The turnstile capability is not configured.
Add `turnstile({ ... })` to a worker's pithy.config.ts (run `pithy add turnstile`).
```

**No widgets are declared.** The capability is composed, but its `widgets` block is empty, so there is nothing to provision.

```
No Turnstile widgets are declared.
Add a `widgets.visible` or `widgets.invisible` entry to turnstile({ ... }) in pithy.config.ts.
```

**Cloudflare credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**The Worker has no production address.** Nothing resolved — no `domains` declaration, no `env.prod` route, no `vars.BASE_URL`. A malformed `domains` block is not fatal here: it is ignored so a widget can still be provisioned off a perfectly good route, and `pithy env` and `pithy deploy` are where a bad block is reported.

```
<worker> has no production address.
Declare it in the Worker's pithy.config.ts — `domains: { prod: { pattern: "app.example.com", zone: "example.com" } }`. The Turnstile widget binds to that domain.
```

**Several Workers, no `--worker`.** The same resolution error `pithy add` raises, naming the Workers it found.

**The project has no name.** It scopes both the widget names and the dispatcher's target, and it is never guessed: a wrong one reuses another project's widget on provision and deletes a neighbor's on teardown.

## Examples

Provision, in a project with one Worker.

```
$ pithy turnstile provision
Test secret wired for dev and staging. 1 production widget(s) ready (1 new).
Done.
```

A re-run over a widget that already exists says what it left alone.

```
$ pithy turnstile provision
Test secret wired for dev and staging. 1 production widget(s) ready (0 new).
Production widgets already existed; their secret was left as-is. If the production gate returns turnstile/config, run `pithy turnstile deprovision` then provision again.
Done.
```

Name the Worker in a project with several.

```
$ pithy turnstile provision --worker web --json
```

Provision onto a host another widget already covers.

```
$ pithy turnstile provision --allow-shared-domain
```

Repair a production gate answering `turnstile/config`.

```
$ pithy turnstile deprovision
$ pithy turnstile provision
```
