# Live test fixtures

Some things cannot be mocked. A Turnstile widget either exists on a real hostname or it does not. Mail is
either delivered or it is not. A certificate is either issued or it is not. The suites that prove those
need a **fixture** — a real thing, made once, in a console, by a human.

This document is the list. Each entry names the fixture, the variables that address it, what skips
without it, and how to make it.

## Absent means skip, never fail

You do not need any of this to work on the kit. A checkout with no credentials runs `bun run test` and
gets green — the live suites skip, and the run says which ones and why.

The report comes from `globalSetup`, once per integration run, before a single suite is collected:

```
fixture absent: turnstile-widget. TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY are not set. Turnstile sign-in gating on a workers.dev hostname (#84) skips. See docs/FIXTURES.md#turnstile-widget.
fixture present: cloudflare-account.
fixtures: 1 present, 7 absent, 0 malformed, 0 declined. A skipped suite is not a passing one.
```

It runs there rather than in a suite hook for the reason the debris sweep does: Vitest runs no hooks
inside a `describe.skipIf(true)`, so anything living in one is gated on exactly the condition it exists to
report.

**Two entry points, chosen by what the package's suites create.** `integrationSetup.ts` reports *and*
sweeps stale Cloudflare resources — the right one for a package that mints a Worker, a database or a
bucket. `fixtureReportSetup.ts` only reports, for a package whose live suites merely read a third party
and so have nothing to reclaim; sweeping the whole account on their way past would be somebody else's
housekeeping, done at a surprising moment. Switch a config from the second to the first the moment one
of its suites creates a resource.

**Three outcomes skip, and only one of them is fine.**

| Outcome | What it means |
|---|---|
| `absent` | No variable is set. The normal case. Nobody did anything wrong. |
| `declined` | A switch is explicitly off. Deliberate. |
| `malformed` | Somebody set it and it will not do — empty, whitespace, or the literal text `undefined` or `null`. |

`malformed` is the one worth reading. A CI job that exports an unset secret produces `""`, which every
`Boolean(value)` check in the world reads as present; a shell that interpolates a missing variable
produces the text `undefined`, which is worse, because it is non-empty and reaches Cloudflare before
anything notices. Neither fails the run — a broken export must not turn "you have no credentials" into
"the kit is broken" — but neither is reported as absent either.

## Where the values go

Either a gitignored `packages/cloudflare/.dev.vars`, or plain environment variables. The file wins where
both state a key. CI passes them as variables and has no file.

```sh
CLOUDFLARE_ACCOUNT_ID=…
CLOUDFLARE_API_TOKEN=…
TURNSTILE_SITE_KEY=…
```

**Never a value in a log, an issue, or a commit.** The report names variables and never their contents,
in every outcome, and a test proves it.

## Using a fixture in a suite

```ts
import { fixtureReady, fixtureValue } from "@pithy-sh/cloudflare/src/test-utils/fixtures";

describe.skipIf(!fixtureReady("turnstile-widget"))("turnstile — LIVE", () => {
  const siteKey = fixtureValue("turnstile-widget", "TURNSTILE_SITE_KEY");
  …
});
```

`fixtureReady` is the only gate. Do not read `process.env` in a live suite: a second spelling of a
fixture is a fixture the report cannot see, and a suite the report cannot explain.

Adding a fixture means adding an entry to `LIVE_FIXTURES` in
`packages/cloudflare/src/test-utils/fixtures.ts` **and** a section here. A test fails if a fixture's `doc`
points at a heading this file does not have.

---

## cloudflare-account

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`

The account every live suite runs against, and the token the run's debris sweep reclaims with. Without
it, every live suite skips and nothing is swept.

**Make it.** The account id is in any dashboard URL, or `wrangler whoami`. Mint the token at
**My Profile → API Tokens → Create Token → Create Custom Token**, scoped to that account. The permission
list is in [`CONTRIBUTING.md`](../CONTRIBUTING.md) § Live integration tests — a live test that returns
403 is almost always a scope missing from it.

**Use a dedicated account.** These suites create and delete real resources, and the deploy round trip
below deletes Workers by computed name. Never point them at an account holding anything you want.

## custom-hostname-zones

`CUSTOM_HOSTNAME_ZONE_ID`, `CUSTOM_HOSTNAME_CUSTOMER_ZONE_ID`

Two zones on one account: one plays the SaaS provider that serves the custom hostname, the other plays
the customer who CNAMEs at it. Unlocks the Custom Hostnames lifecycle suite (#41).

**Make it.** Nothing to buy. The maintainer account holds four active zones — `pithy.sh`, `pithy-sh.com`,
`pithy.run`, `pithysh.com` — so pick two and take their zone ids from **Overview → API** on each. The
customer's CNAME is a DNS record the suite creates and deletes like any other throwaway resource.

Do not use `pithy.sh` as the provider zone: its apex MX is Google Workspace and it carries real mail.

## email-routing

`EMAIL_ROUTING_ZONE_ID`, `EMAIL_ROUTING_ADDRESS`

A zone with Cloudflare Email Routing enabled, and an address on it that routes to a Worker. Unlocks the
inbound bounce-handling suite (#47).

**It already exists on the maintainer account.** `pithy-sh.com` has Email Routing enabled, and
`help.pithy-sh.com` has `MX → route1/2/3.mx.cloudflare.net`. The subdomain is deliberate: Email Routing
takes over MX, and `pithy.sh`'s apex is on Google Workspace.

**Two facts a suite must be written around, because they will not be changed:**

- The zone's only rule is a **catch-all that drops**. Mail sent there goes nowhere by default; the suite
  provisions its own worker route and must tear it down.
- There are **zero verified destination addresses**. A test that expects delivery to a mailbox will wait
  forever. Assert on the Worker's `email()` handler, not on an inbox.

`pithy.sh` reports its Email Routing as `misconfigured`. That is a Cloudflare-side artifact of an apex
that is not configured for routing, it is known, and it is not a bug to file.

**Make it elsewhere.** **Email → Email Routing → Get started** on a zone whose MX you are willing to move,
then **Destination addresses** for anything you want actually delivered.

**The address is read for its domain, not claimed.** The live suite mints its own
`pithy-int-…@<that domain>` address per run and provisions a rule for that, so two runs cannot collide
and the fixture's own address is never touched. Point it at anything on the routed hostname.

**The token needs more than the account scopes.** Email Routing Rules: Read and Edit on the zone, plus
Workers Scripts: Edit and Workers KV Storage: Edit — the suite deploys a throwaway Worker to route mail
to, because Cloudflare refuses a rule whose target script does not exist (`2016 Workers Script Info not
found`).

## email-sending

`EMAIL_SENDING_FROM`

An address on a domain onboarded to Cloudflare Email Sending, which the live inbound suite posts its
test message from. Unlocks the delivery half of #47 — the half that proves an inbound message reaches a
Worker's `email()` handler, rather than only that the rule was created.

**It already exists on the maintainer account.** `pithy.sh` is onboarded and DKIM-signed
(`cf2024-1._domainkey`), so `noreply@pithy.sh` is the value.

**The token needs Email Sending: Edit**, which a general account token does not carry — the endpoint
answers `10000` without it.

**Cloudflare refuses to set some headers on a send.** `Authentication-Results` and `Received` are
rejected with `10202 email.sending.error.email.invalid`, and a CRLF smuggled into a custom header's
value is rejected the same way. That is why the forged-`Authentication-Results` question in #47 cannot
be answered from this fixture: the only sender available refuses to forge. Arbitrary `X-` headers *are*
accepted, which is what the suite addresses its record with.

## google-oauth

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

An OAuth 2.0 client for the Google provider suite —
`packages/auth/src/instance/googleProvider.integration.test.ts` (#84).

**No live origin is needed.** Google accepts `http://localhost` redirect URIs, so this suite runs locally
against a port it picked itself and never against a deployed Worker. There is no `e2e.` subdomain to
register and no fixed origin to hold.

**And no redirect URI needs registering, either.** The suite never completes a Google round trip —
driving a consent screen needs a human, a browser and whatever 2FA the account carries, and a nightly
built on that fails for Google's reasons rather than for Pithy's. It asserts the two things only the
real provider can answer: the `redirect_uri` this app hands the browser, composed from the port the OS
assigned this run, and whether Google recognises the credential — posted to the token endpoint with a
code that is not one, Google answers `invalid_grant` for a client it knows and `invalid_client` for one
it does not. Register a URI only if you want to drive the flow by hand.

**Make it.** Google Cloud console → **APIs & Services → Credentials → Create credentials → OAuth client
ID → Web application**. Nothing else.

**`basePath` is pinned in the suite, and the pin is itself tested.** It defaults to `/auth` and is
configurable, so a silent change invalidates every registered redirect URI at once and surfaces as a
Google error page rather than as a config diff. Every app the suite boots states its base path, and one
case boots a second app at `/identity` to show the assertion follows the pin rather than the default.

## live-deploy

`PITHY_LIVE_DEPLOY`

A switch, not a credential. On is `1`, `true`, `yes` or `on`; off is `0`, `false`, `no` or `off`; anything
else is malformed and skips.

It arms the secrets round trip — provision, write, rotate, audit, teardown — which deploys real Worker
scripts, runs real Workflows, writes to the account's one Secrets Store, and then deletes all of it. That
is why it is a separate word from the credentials: having an account is not consent to deploy into it.

Every name it touches is composed under the reserved project `pithy-int-test`, so teardown can only ever
address its own.

```sh
PITHY_LIVE_DEPLOY=1 bun run --filter @pithy-sh/cli test:integration
```

**Make it.** Nothing to make. Set the variable when you mean it.

One account-level prerequisite: a registered `workers.dev` subdomain, which Cloudflare requires before it
will deploy a Worker hosting a Workflow. Opening **Workers & Pages** in the dashboard once creates it.

## r2-s3-keys

`R2_CREDENTIALS` — a JSON object, `{"accessKeyId":"…","secretAccessKey":"…"}`

R2's S3-protocol key pair. Unlocks the presigned-URL suite, and the bucket reaper.

**The API token cannot stand in for it.** Cloudflare refuses to delete a non-empty bucket, and emptying
one is an S3 operation the REST API does not offer. So without this, stale `pithy-int-` buckets pile up
and the sweep says so rather than going quiet.

**Make it.** **R2 → Manage R2 API Tokens → Create API token**, Object Read & Write. Copy the Access Key
ID and Secret Access Key into the JSON above on one line.

## secrets-store

`SECRETS_STORE_ID`

The account's Secrets Store. Unlocks the Secrets Store suites, and reclaiming stale entries — without it
the sweep does not know which store to sweep, and `pithy-int-secret-…` entries survive indefinitely.

**Make it.** **Secrets Store** in the dashboard; an account has one. Its id is in the URL. The API token
needs Secrets Store Read and Write.

## turnstile-widget

`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`

A real Turnstile widget. Unlocks the real-widget half of the sign-in gating suite —
`packages/auth/src/http/turnstileGate.integration.test.ts` (#84).

**A test key cannot do this job.** A scaffolded dev config uses Cloudflare's documented test sitekey
(`1x00000000000000000000AA`), which always passes — so it cannot tell "the widget worked" from "the gate
never ran", which is the one thing the suite exists to establish. The suite refuses one on sight, and
not by string-matching a list kept here: siteverify sets `metadata.result_with_testing_key` on every
answer produced by a documented test key and on none produced by a real widget, so a fixture wrongly
filled in with a test key fails loudly rather than certifying a gate that never ran.

**What a widget still would not prove.** The gate is stacked as `turnstile({ action: "login" })` and
fails closed when the action siteverify returns does not match. A test key's answer carries no action at
all — which used to mean even the always-pass secret was refused, and no live suite could watch the gate
let anything through. Since #374 the middleware relaxes that binding for exactly that answer, in exactly
the two environments a test key is provisioned into, so the **pass-then-forward path is covered live**
without a widget. What a widget would still add is the binding *biting*: a token minted for one action
and replayed against another. No key available here returns an action at all, so producing a mismatch
needs a real widget rendered with `action: "login"` and solved in a browser — a harness (#107) rather
than a fixture. Until then that case lives in `@pithy-sh/turnstile`'s own suites.

**No custom domain, and no zone.** The widget goes on the hostname of a deployed Worker. On the
maintainer account the `workers.dev` subdomain is `jim-02d`, so a Worker deployed as `pithy-int-test-ui`
is reachable at `pithy-int-test-ui.jim-02d.workers.dev` and that is the hostname the widget allows. Yours
is whatever Cloudflare assigned you — **Workers & Pages → Subdomain** says which.

**Make it.**

1. Deploy the Worker first, so you know its hostname. `pithy deploy`, or `bun x wrangler deploy`.
2. **Turnstile → Add widget**.
3. Name it `pithy-int-test`, so it reads as test estate rather than as production.
4. Add `<worker>.<subdomain>.workers.dev` as a hostname. A bare `workers.dev` is not accepted, and
   subdomains of an allowed hostname are permitted, so the full name is what to enter.
5. Widget mode **Managed**.
6. Copy the **Site Key** into `TURNSTILE_SITE_KEY` and the **Secret Key** into `TURNSTILE_SECRET_KEY`.

**The account has no widget today**, and creating one needs a token with Turnstile Sites Write — the
read-only path returns an empty list and says nothing about why. So this fixture reports `absent` until
somebody makes it in the console, which is exactly what the report is for.
