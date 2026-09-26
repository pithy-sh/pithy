# pithy turnstile

_The site renders this for readers: [pithy.sh/docs/cli/commands/turnstile](https://pithy.sh/docs/cli/commands/turnstile). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Wire Cloudflare's Turnstile test keys into dev and staging, provision the real production widget, write every environment's sitekey into `pithy.config.ts`, and tear it back down.

## Synopsis

```
pithy turnstile provision [--worker <name>] [--allow-shared-domain] [--json]
pithy turnstile deprovision [--worker <name>] [--json]
```

**Both subcommands need a Cloudflare account.** A production widget is an account resource, and its secret is written to a managed store through a deployed dispatcher. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are checked before anything is created.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--worker <name>` | both | the project's only Worker | The web-facing Worker. Its production address binds the widget, its `turnstile({ ... })` registration is read for the widget modes, and its `pithy.config.ts` gets the sitekeys. Required when the project has several |
| `--allow-shared-domain` | `provision` | `false` | Provision even though another Turnstile widget already covers the domain |
| `--json` | both | `false` | One line of machine-readable output |

There is no `--env`. A widget binds to the domain a human loads it on, so `prod` is not a parameter: the production hostname is resolved from the target Worker, and dev and staging get Cloudflare's documented test keys either way.

There is no `--mode`. Which widgets exist is declared in the Worker's `pithy.config.ts` under `turnstile({ widgets })`, and a flag would be a second source of truth that drifts the moment someone enables one in config.

## What it does

`provision` reads the enabled widget modes from the target Worker's `turnstile({ widgets })` — `visible`, `invisible`, or both — and resolves the production hostname through the one address resolver: the Worker's `domains` declaration for `prod`, else its `env.prod` route, else a hand-set `vars.BASE_URL`. **The modes and the sitekeys come from the same Worker.** They used to come from two: the modes from the first Worker composing `turnstile`, the sitekeys to `--worker`.

Then it does four things. **dev and staging** get Cloudflare's documented test secret, written per environment — dev to the dev secrets file, staging to its managed store. **`prod`** gets a real widget per mode, bound to that hostname, its secret written to the production managed store. **Every environment's public sitekey** is written into the Worker's `pithy.config.ts`, in the `turnstile({ ... })` registration: the always-pass test sitekey for dev and staging, the real widget's for prod. And **any `TURNSTILE_SITEKEY_*` var** an older provisioner left in that Worker's `wrangler.jsonc`, or in `dev.json`, is removed. Only that Worker's: a var the old split left in a Worker that composes no turnstile, or in the project root's `.dev.vars`, is yours to delete, and `pithy doctor` says so.

**Every refusal is decided before anything is created.** A domain a foreign widget already covers, production widgets of which some exist and some do not, and a sitekey the writer would refuse are all readable from the account's widget list and the Worker's config. So they are checked first, and a refused run leaves the account, the secret stores and every file as it found them. `deprovision` checks its sitekey edit before it deletes anything, for the same reason.

### The sitekeys are a build input

The front end gets its sitekey from `virtual:pithy/turnstile`, which the `pithy()` Vite plugin inlines **when the bundle is built**, from `widgets.<mode>.sitekeys.<environment>`. So that block is where provisioning writes, and nothing it writes reaches a deployed bundle until the Worker is built and deployed again. **Redeploy staging and prod after provisioning.** The output says so.

Before this, the sitekeys went into `env.<name>.vars` and `.dev.vars` as `TURNSTILE_SITEKEY_<MODE>`, where no code read them: the config stayed blank, no widget rendered, and sign-in failed closed on a successful provision. `pithy doctor` names any such var still in a Worker's `wrangler.jsonc`, in `dev.json`, or in the project root's `.dev.vars`.

**String literals, in place, and nothing else.** A value is replaced only where the config states a string literal. An expression that already resolves to the value — `dev: testSitekey("visible")` — is left alone. One that resolves to something else is refused by key, before a byte is written. After writing, the config is loaded back through the real loader, and a value the capability does not then resolve puts the file back and refuses.

**A declared environment beyond dev, staging and prod has no sitekey.** The projection indexes `TurnstileSitekeys` by the environment being built, so a declared `live` renders no widget and sign-in there is blocked. Nothing provisions it — a test key is accepted only where one belongs, and the one real widget is prod's — so `provision` names it in its output rather than leave the bundle to say `enabled: false` in silence.

**A feature build needs nothing provisioned.** `TurnstileSitekeys` carries an optional `feature` key, and a branch build left with none resolves Cloudflare's always-pass test sitekey for the widget's mode; the gate resolves the matching test secret the same way when the branch's secrets store holds none. Both halves are defaults rather than writes, because a feature's config and store are generated per branch and nothing an adopter or this command writes could reach them — which is why a branch deployment used to answer `500 turnstile/config` on every sign-in. State `feature` to run a real widget on a branch, or `""` for no widget at all; `provision` never writes that key, so a project scaffolded before it existed provisions exactly as it did.

**A test key belongs in dev, staging and a feature build, and nowhere else — the gate enforces that.** Cloudflare flags its own answers from a documented test key (`metadata.result_with_testing_key`), so a Worker stamped `prod` — or stamped nothing — refuses one with `turnstile/config` rather than letting a secret that passes everybody stand in for a widget. It is the same flag that lets those three sign in at all: a test key's answer carries no `action`, which the login gate's action binding would otherwise refuse (#374). See [pithy.sh/docs/capabilities/turnstile/reference](https://pithy.sh/docs/capabilities/turnstile/reference).

Idempotent: a re-run reuses an existing production widget rather than creating a second one, and writes the same sitekeys again — a config already holding them is not touched. That reuse has one consequence worth stating, because it is the failure adopters hit. Cloudflare never returns an existing widget's secret, so it cannot be recomposed — a re-run over widgets that already exist leaves the stored secret exactly as it was, and reports that it did. If the secret was never stored, re-running will not heal it; `deprovision` then `provision` is what does.

`--allow-shared-domain` is the escape hatch for the one legitimate case: an adopter already running a hand-made widget on that host who is not ready to retire it. Off by default, because the refusal is the useful answer.

`deprovision` deletes the production widget for each declared mode, deletes the managed secret and the dev secret, blanks each mode's `prod` sitekey in `pithy.config.ts`, and removes any stranded sitekey var. The test sitekeys stay: they are Cloudflare's published constants. It is the inverse of `provision` and the first half of the repair for a lost production secret.

## `--json`

One line, one object, one shape per subcommand. The `command` field carries the space-separated form (`turnstile provision`), not the dotted one.

```
$ pithy turnstile provision --json
{"command":"turnstile provision","modes":["visible"],"widgets":[{"mode":"visible","sitekey":"0x4AAA…","created":true}],"productionSecretWritten":true,"sitekeys":{"visible":{"dev":"1x00000000000000000000AA","staging":"1x00000000000000000000AA","prod":"0x4AAA…"}},"strandedVarsRemoved":[{"name":"TURNSTILE_SITEKEY_VISIBLE","environment":"prod"}],"configFile":"apps/web/pithy.config.ts","redeployRequired":true,"environmentsWithoutSitekeys":[]}
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
| `sitekeys` | `object` | Per mode, the `dev`, `staging` and `prod` sitekeys written into `pithy.config.ts`. Public by definition |
| `strandedVarsRemoved` | `object[]` | Each `TURNSTILE_SITEKEY_*` var removed this run — its `name`, and the `environment` whose vars held it (`dev` for the top level and `dev.json`). Empty on a project provisioned since the sitekey moved into config |
| `configFile` | `string` | The `pithy.config.ts` the sitekeys were written to, relative to the project root |
| `redeployRequired` | `true` | Always. The sitekeys are inlined when the front end is built, so no deployed bundle carries them until the Worker is deployed again |
| `environmentsWithoutSitekeys` | `string[]` | Every environment this project builds a front end for that no sitekey can reach — a **declared** one beyond dev, staging, prod and a feature build. Builds there render no widget, and sign-in is blocked. A feature build is not one: it resolves the test sitekey by default |

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

**The Worker does not compose turnstile.** The target — `--worker`, or the project's only Worker — has no `turnstile(...)` registration. The modes are never read from a sibling.

```
<worker> does not compose the turnstile capability.
Add `turnstile({ ... })` to <worker>'s pithy.config.ts (run `pithy add turnstile`), or name the Worker that composes it with --worker.
```

**No widgets are declared.** The capability is composed, but its `widgets` block is empty, so there is nothing to provision.

```
No Turnstile widgets are declared.
Add a `widgets.visible` or `widgets.invisible` entry to turnstile({ ... }) in pithy.config.ts.
```

**A sitekey cannot be written.** The registration has no `widgets.<mode>.sitekeys.<environment>` object literal to write into, or that key is an expression resolving to something else. A production sitekey Cloudflare has not issued yet can only go into a string literal: no expression already resolves to it. Checked before a widget is created or deleted and before a secret or a file is written, so nothing is.

```
Could not write widgets.visible.sitekeys.staging in <path>. Each is an expression that resolves to something else.
Set widgets.visible.sitekeys.staging: "1x00000000000000000000AA" in the turnstile({ ... }) registration by hand, then run the command again. Only string literals are written.
```

The registration is found only where `turnstile({` opens a line. A config that writes the whole `capabilities` array on one line gets the same refusal, for every key.

```
Could not write widgets.visible.sitekeys.dev, widgets.visible.sitekeys.staging, widgets.visible.sitekeys.prod in <path>. No `turnstile({ ... })` registration opens a line of it. Put the call on its own line.
```

**The production widgets are in a mixed state.** One mode's widget exists and another's does not, so no consistent production secret can be composed. Refused before anything is written.

```
Turnstile production widgets are in a mixed state — some exist, some do not.
Run `pithy turnstile deprovision`, then provision again to write a consistent production secret.
```

**The written sitekeys are not what the capability reads.** The config, loaded back, resolves something other than what was written — the edit landed somewhere the capability does not read. The file is restored.

```
The sitekeys written to <path> are not what the turnstile capability reads. The file was restored.
Set widgets.visible.sitekeys.prod: "0x4AAA…" in the turnstile({ ... }) registration by hand.
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
A feature deployment uses the same test pair by default — nothing to provision, and no redeploy of a branch needed for it.
Sitekeys written to apps/web/pithy.config.ts for dev, staging and prod.
The build inlines them. Redeploy staging and prod before the widget renders there.
Done.
```

A project provisioned before the sitekeys moved into config gets its stranded vars removed.

```
$ pithy turnstile provision
Test secret wired for dev and staging. 1 production widget(s) ready (0 new).
A feature deployment uses the same test pair by default — nothing to provision, and no redeploy of a branch needed for it.
Production widgets already existed; their secret was left as-is. If the production gate returns turnstile/config, run `pithy turnstile deprovision` then provision again.
Sitekeys written to apps/web/pithy.config.ts for dev, staging and prod.
The build inlines them. Redeploy staging and prod before the widget renders there.
Removed stranded vars nothing read: TURNSTILE_SITEKEY_VISIBLE (dev), TURNSTILE_SITEKEY_VISIBLE (staging), TURNSTILE_SITEKEY_VISIBLE (prod).
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
