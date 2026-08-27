# pithy email

_The site renders this for readers: [pithy.sh/docs/cli/commands/email](https://pithy.sh/docs/cli/commands/email). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stands up the email infrastructure — the project's shared suppression database, a per-environment email worker, and optionally the inbound rule that routes bounces back at your app — and sends one rendered template so you can see it arrive.

## Synopsis

```
pithy email provision [--worker <name>] [--routing-zone <zone-id>] [--inbound-address <address>] [--app-worker <name>] [--json]
pithy email deprovision [--suppression] [--json]
pithy email test --to <address> [--template <id>] [--from <address>] [--json]
```

**All three subcommands reach a Cloudflare account.** There is no local mode and no `--env` flag: provisioning spans every managed environment — `staging` and `prod` — in one run, and `test` sends a real message through the Cloudflare Email Sending API.

## Flags

`pithy email provision`

| Flag | Default | Purpose |
|---|---|---|
| `--worker <name>` | the project's only Worker | The app Worker whose `wrangler.jsonc` carries the per-environment `DB` binding and public address. Required when a project has several |
| `--routing-zone <zone-id>` | — | Cloudflare Zone ID of the (sub)domain receiving the mail. Email Routing must already be enabled on it |
| `--inbound-address <address>` | — | The exact recipient address the rule matches, e.g. `bounce@bounce.example.com` |
| `--app-worker <name>` | — | Deployed name of the production app worker running `createEntrypoint` with the `email()` bounce handler |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy email deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--suppression` | `false` | **Irreversible.** Also delete this project's suppression database — every environment forgets who unsubscribed or hard-bounced |
| `--json` | `false` | Machine-readable output |

`pithy email test`

| Flag | Default | Purpose |
|---|---|---|
| `--to <address>` | — | **Required.** Who receives the sample |
| `--template <id>` | `welcome` | Which template to render. One of `magicLink`, `supportReply`, `otp`, `welcome`, `securityAlert`, `invite`, `testerNudge`, `passwordChanged`, `operationalNotice`, `newsletter`, `leadCapture`, `marketingCampaign` |
| `--from <address>` | the configured `fromAddress` | Override the sending address for this one message |
| `--json` | `false` | Machine-readable output |

**The three routing flags are wired only when all three are given.** A partial set is treated as no routing at all: everything else provisions and `routing.skipped` is `true`. Enabling Email Routing on a zone points its MX at Cloudflare, so the zone, the address, and the target worker are an operator's decision rather than something derived. Use a subdomain zone, never your apex, so your primary MX is untouched.

## What it does

`provision`, in order — and the order is the contract:

1. **Preflight.** Verify the account can host a Workflow at all — most importantly a registered `workers.dev` subdomain.
2. **Suppression database.** Create or reuse `<project>-global-email-suppressions`, one per project rather than one per environment: an unsubscribe in production has to stop staging too.
3. **Migrate it.** Run `email_0001_suppressions` against that database. Applied migrations skip.
4. **Workers.** Deploy the prebuilt email worker for every managed environment, each bound to the shared suppression database and to its own environment's resources.
5. **Routing rule.** Last, and only with all three routing flags.

Each environment's deploy needs three things resolved first, and each missing one is refused rather than deployed around: the app `DB` id from that environment's stanza in the app Worker's `wrangler.jsonc`; that Worker's public address for the environment; and the environment's secrets database — `<project>-<env>-secrets`, looked up live, which `pithy secrets provision` creates.

The address is resolved through one resolver that prefers the Worker's `domains` declaration, falls back to its route, and then to `vars.BASE_URL`. Tracking and unsubscribe links are built against whatever it returns, so a Worker with none of the three is refused rather than deployed against a guess. A malformed `domains` declaration does not block provisioning off a good route or var — `pithy env` and `pithy deploy` are where that gets reported.

`deprovision` deletes every environment's email worker first, because they bind the suppression database, and then deletes the database itself only when `--suppression` is passed. The global opt-out list is preserved by default; losing it is harmful.

`test` renders one template through your project's own configuration — identity, theme, and all — and sends it over the Cloudflare Email Sending REST API. It deploys nothing. A throwaway tracking context is built so that any template renders, including marketing templates that force an unsubscribe link, but open and click tracking are both off and no link is actually tracked: this is a visual and delivery check of your configuration. A transactional template still renders without an unsubscribe link and without a `List-Unsubscribe` header, tracking context or not — the kind is declared by the template, so there is no context that could add one to a sign-in message.

`provision` and `deprovision` audit what they did, when the project composes `@pithy-sh/audit` and credentials resolve. Auditing is a no-op otherwise.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

`pithy email provision`

| key | type | meaning |
|---|---|---|
| `command` | `"email provision"` | The subcommand that produced this line |
| `suppressionDatabaseId` | string | The D1 id of the project's shared suppression database, created or reused |
| `environments` | array of `"staging" \| "prod"` | The environments an email worker was deployed for |
| `routing` | object | What happened to the inbound Email Routing rule |
| `routing.created` | boolean | True only when this run created the rule. False when it already existed |
| `routing.skipped` | boolean | True when the routing flags were absent or incomplete, so no rule was made |

`pithy email deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"email deprovision"` | The subcommand that produced this line |
| `suppressionDeleted` | boolean | Whether `--suppression` was passed, and therefore whether the shared suppression database was deleted |

`pithy email test`

| key | type | meaning |
|---|---|---|
| `command` | `"email test"` | The subcommand that produced this line |
| `template` | string | The template id that was rendered — the value of `--template` |
| `to` | string | The recipient the sample was sent to |
| `from` | string | The address it was sent from: `--from` when given, otherwise the configured `fromAddress` |
| `messageId` | string | The id Cloudflare assigned the message. **Absent from the line** when the API returned none — the key is omitted rather than emitted as null |

A failing run writes `{"error":{…}}` to stderr instead and exits 1 — the same public payload the HTTP surface encodes, with `detail` stripped.

## Errors

Each is a `PithyError`: the problem, then the action.

**The capability is not configured.** No Worker's `pithy.config.ts` composes `email`.

```
The email capability is not configured.
Add `email({ ... })` to a worker's pithy.config.ts (run `pithy add email`).
```

**Credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**No Secrets Store id.** The email worker decrypts its signing key from it. All three subcommands resolve credentials through the same reader, so `deprovision` and `test` are refused without it too, though neither writes a secret.

```
The CF Secrets Store id is missing.
Run pithy add secrets to record SECRETS_STORE_ID (the email worker decrypts its signing key from it).
```

**The project has no name.** The suppression database is found by name and reused, so a guessed name would adopt another project's opt-out list.

```
pithy.config.ts has no `name`.
```

**The app Worker's environment is not wired**, or has no address for it:

```
api's wrangler.jsonc env.prod has no DB database_id.
Provision the prod app database and set its id on the DB binding.
```

```
api has no prod address.
Declare it in the Worker's pithy.config.ts — `domains: { prod: { pattern: "…", zone: "…" } }`. Tracking and unsubscribe links are built against it.
```

**The secrets database does not exist.**

```
The prod secrets database (acme-prod-secrets) does not exist.
Run `pithy secrets provision` first — the email worker reads its signing key from it.
```

**An unknown template.**

```
No sample payload for template "welcom".
Known templates: magicLink, supportReply, otp, welcome, securityAlert, invite, testerNudge, passwordChanged, operationalNotice, newsletter, leadCapture, marketingCampaign.
```

**Several Workers and no `--worker`.** The resolution error `pithy add` raises, naming the Workers it found.

## Examples

Provision without routing, then add the rule once the bounce subdomain exists:

```
$ pithy email provision
Suppression database and 2 email workers ready.
Done.
```

```
$ pithy email provision --routing-zone 0a1b2c3d --inbound-address bounce@bounce.example.com --app-worker acme-prod --json
{"command":"email provision","suppressionDatabaseId":"3f7c…","environments":["staging","prod"],"routing":{"created":true,"skipped":false}}
```

Send yourself the magic-link template as your project renders it:

```
$ pithy email test --to sam@example.com --template magicLink
Sent "magicLink" from hello@acme.com to sam@example.com (msg-4821).
Done.
```

```
$ pithy email test --to sam@example.com --template magicLink --json
{"command":"email test","template":"magicLink","to":"sam@example.com","from":"hello@acme.com","messageId":"msg-4821"}
```

Take the workers down and keep the opt-out list:

```
$ pithy email deprovision --json
{"command":"email deprovision","suppressionDeleted":false}
```
