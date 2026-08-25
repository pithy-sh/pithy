# @pithy-sh/email

D1-backed email for Cloudflare. Every send is a durable job: scheduled, retried, tracked. Themeable templates, click/open/unsubscribe tracking, and bounce-driven suppression. No mail ever sent inline.

## How it works

A request handler never sends email. It **enqueues a row** in `pithy_email_jobs`, and the actual `EMAIL.send()` always runs inside a Cloudflare Workflow — so every send is durable, retryable, and auditable.

There are three send modes. **Immediate** inserts a `pending` row and starts the send Workflow now. **Scheduled** inserts a `scheduled` row with an absolute `sendAt`. **Per-timezone** resolves a recipient's local time-of-day in their IANA zone to an absolute `sendAt`. An every-minute cron Workflow finds due rows and fans them out into sender batches sized to the volume due.

Links in a tracked email are HMAC-signed callbacks. A click goes through `/_pithy/email/c/<token>` (records the click, 302-redirects to the signed destination); an open loads `/_pithy/email/o/<token>.png`; an unsubscribe hits `/_pithy/email/u/<token>`. The signing key is a rotatable secret from `@pithy-sh/secrets`, and every token carries its key version so a link in a months-old email still verifies after a rotation.

`pithy add email` mints this project's **dev** signing key into the dev secrets file as `email-link-signing-key` — any random string signs a link this app also verifies, so there is nothing for you to invent. It is written only when absent: a new key breaks every link already in an inbox. Deployed environments need their own, with `pithy secrets create email-link-signing-key`.

### What an enqueue answers with

The job id, the status it was born as, the reason it was withheld if it was — and **the subject the row was written with**, in the recipient's language.

```ts
const { jobId, status, subject } = await emailCapability.enqueue(env, {
  to: "someone@example.com",
  template: "invite",
  payload: { inviterName: "Sam", organizationName: "Acme", acceptUrl },
  locale: "es",
});
// subject === "Sam te ha invitado a Acme" — the sentence the row was born with, not a second rendering of it.
```

That is for the caller with an administrative trail to write. Re-rendering the subject to record it means restating the theme you configured and the layer stack you composed, then pinning your copy against the kit's catalog to notice when the kit's wording moves. An audit row written at enqueue instead reads the same string the job row was written with.

**Locale is what makes it more than a convenience.** A trail that mirrors the English sentence by hand agrees with the row by coincidence, for as long as there is one language. Pass a `locale` and the template renders the recipient's catalog while the mirror keeps restating English — and the trail then claims a subject nobody was ever sent.

**It is the enqueue-time render, and `runSend` remains the authority on what was delivered** — because the send renders again, in the send Worker, at the moment the message leaves, and rewrites `pithy_email_jobs.subject` from that render. Three things part the two renders: a template corrected, a theme renamed, or a catalog sentence retranslated. A subject can interpolate your theme (`welcome`'s takes `theme.appName`), so a rename parts them with no catalog movement at all.

**And the gap between the two is not only the wait in the queue.** Waiting sets one bound on it, seconds for an immediate send and days for a `scheduled` one. The other is that the send Workflow is its own deploy: it carries the kit's email copy in its own bundle, and your theme and override sentences in vars stamped at provision ([docs/I18N.md](../../docs/I18N.md)). So a send Worker whose copy has drifted from the Worker that enqueued is not a window a fast send outruns — it stands until the two are back in step, and an immediate send lands inside it like any other. So record it as what you queued. A trail that has to reflect delivery reads the row back after the send.

Every result carries it, a `suppressed` one included: the withheld row has a rendered subject like any other, no send will ever rewrite it, and a message that reached nobody is the one an operator most needs on the record. The body is deliberately not here — it is large, it is the thing this capability is careful never to log, and it is rendered inside the Workflow at the moment it leaves.

### Sending from your own Workflow

A route reaches `enqueue` through the `compose` hook, and should keep doing that — it is typed and explicit. **A Workflow class has no such route:** the runtime constructs it with the worker `env` and nothing else, `enqueue` is a closure rather than a binding, and Workflow params are serialized so a closure cannot travel in one either. Rebuilding the send identity inside the step would put your sending address in a second place, free to drift from `pithy.config.ts`.

So a durable job asks for it by env alone:

```ts
import { enqueueFromEnv } from "@pithy-sh/email/src/send/fromComposition";

export class RotationWorkflow extends WorkflowEntrypoint<Env, RotationParams> {
  override async run(event: WorkflowEvent<RotationParams>, step: WorkflowStep) {
    await step.do("notify", async () => {
      await enqueueFromEnv(this.env, { to, template: "operationalNotice", payload });
    });
  }
}
```

It is the same bound `enqueue` a route holds — same from-identity, same theme, same automatic suppression — reached through the composed set `createBackend` records at assembly. Export the Workflow class from the same worker entrypoint that calls `createBackend`, which Cloudflare requires anyway; where it is not composed, this raises a wiring fault naming what to add rather than sending as an invented identity.

## Deployment architecture

```mermaid
flowchart TB
  subgraph appenv["App Worker — every environment (prod, staging, feature-*)"]
    routes["routes: enqueue + /_pithy/email/c,o,u callbacks"]
    stats["campaignStats(campaignId)"]
  end

  subgraph appprod["App Worker — PRODUCTION only (the one Email Routing target)"]
    inbound["email() bounce/complaint handler"]
  end

  subgraph emailw["Email Worker (prebuilt, per environment)"]
    send["EmailSendWorkflow"]
    sched["EmailSchedulerWorkflow + every-minute cron"]
  end

  cf["Cloudflare Email Service<br/>(send_email binding)"]
  inbox["Recipient inbox"]

  subgraph data["Databases"]
    appdb[("App DB — pithy_email_jobs + events<br/>one per environment")]
    proddb[("Production App DB<br/>(jobs + events)")]
    supdb[("EMAIL_SUPPRESSIONS<br/>shared, durable, ONE per account")]
    secrets[("SECRETS — link-signing key<br/>shared, durable")]
  end

  routes -- "insert job + open/click/unsubscribe events (+campaignId)" --> appdb
  routes -- "immediate: create()" --> send
  routes -- "unsubscribe → suppress" --> supdb
  routes -- "verify token (read key)" --> secrets
  sched -- "due rows → batches" --> send
  send -- "render + send" --> cf
  send -- "sent event + messageId" --> appdb
  send -- "check suppression" --> supdb
  send -- "permanent_bounces → suppress" --> supdb
  send -- "read signing key" --> secrets
  cf --> inbox
  inbox -- "DSN / complaint (ONE routing rule per domain)" --> inbound
  inbound -- "suppress (global — every env honors it)" --> supdb
  inbound -- "bounce/complaint event — PRODUCTION DB only" --> proddb
  appdb -- "aggregate events by campaign" --> stats
```

**How a bounce gets back — and the honest limit.** Cloudflare binds **one** Worker per domain to receive mail, so every DSN/complaint lands in the *production* app worker. From there:

- **Suppression is global.** The inbound worker writes the bounced/complained address into the shared `EMAIL_SUPPRESSIONS` DB, which every environment checks before sending — so the dangerous part (don't email this person again) is correct everywhere.
- **The bounce *event* is production-only.** The worker matches the DSN to its job by the original `Message-ID` and writes a `bounce`/`complaint` event (with that job's `campaignId`) into the **production** app DB — so a production campaign's `campaignStats` sees bounces beside its opens and clicks. It **cannot** write that event back to a staging or feature DB: those are separate, often ephemeral databases the single production worker has no binding to. There is no way around this with one inbound worker — the `X-Pithy-Env` header we stamp on each send lets the worker *know* which environment a bounce came from (for logging), but it can't reach that environment's database.

So non-production environments get their full open/click/unsubscribe funnel (those callbacks hit the *sending* env's own worker) plus the **synchronous** `permanent_bounces` captured at send time, but not *asynchronously*-routed bounce events. Production — where batch analytics actually matter — gets everything.

## Local development

`pithy dev` runs the prebuilt email host beside your app Workers, and mail sent from localhost is delivered for real.

**A magic link you trigger from localhost arrives in a real inbox.** The host's `send_email` binding is resolved with `remote: true` under `dev`, so the Worker runs on your machine and delivers through Cloudflare Email Service — the same pipeline, the same DKIM, the same delivery logs as production. That needs two things this kit does not own: a Cloudflare login `wrangler dev` can use, and a sending domain already onboarded onto Email Service.

**One flag chooses otherwise.** `email({ devDelivery: "simulator" })` sends nothing: `wrangler dev` logs the sender, recipient and subject, and writes the rendered HTML and text bodies to disk. That is what an offline machine and CI want, and it is the setting to reach for if you would rather a test sign-in did not really reach whatever address it was given. It changes local development only — every deployed environment always sends for real.

**How the dispatch travels.** A deployed app Worker starts a send through a cross-script Workflow binding naming `<project>-<env>-email`. Locally there is no such script: each Worker is its own `wrangler dev`. So the host mounts one route, `POST /__pithy/workflows/:binding`, and `pithy dev` composes a loopback dispatcher pointed at `EMAIL_ORIGIN` in its place. The route starts the instance on the host's *own* same-script binding, under the id the row already carries, and it answers only in a `dev` composition — `staging` and `prod` are refused, where the binding is the only path in.

**A send nothing can carry says so.** An immediate job enqueued by a composition that binds no send Workflow is born `undispatched`, not `pending`, and the `EnqueueResult` says the same:

```ts
const { status } = await emailCapability.enqueue(env, { to, template: "magicLink", payload });
// status === "undispatched" — nothing was started, and nothing is coming yet.
```

A missing binding is a configuration fact, not a transient error. The safety net that justifies swallowing a *failed* dispatch is the every-minute cron on the host worker, and a deployment with no dispatcher has no host worker either — so `pending` there was a promise nothing could keep, and "check your inbox" was a lie the row agreed with. A dispatcher that is present and throws still behaves exactly as it always did: the row stays `pending`, and the scheduler re-drives it within the minute.

It is a truthful status, never a grave. The day the host is deployed, its first tick claims those rows exactly as it claims a stranded `pending` one — a tick running at all is the host existing — so mail enqueued before `pithy email provision` is delayed, not lost. `POST /email/jobs/:id/retry` on a composition with no binding writes the same word for the same reason: one deployment, one name for one fact.

**The host says what it is missing, before it serves anything.** Its fourteen settings are one Zod object with a `.describe()` per field (`workflows/hostEnv.ts`), parsed at every entry. A missing `BASE_URL`, an `EMAIL_THEME` that will not parse, a `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` — each is one line naming the field, why it is unusable, and the binding, var, config key or `pithy` command that fills it. `pithy doctor` reads the same object, so the check you run and the check the host runs cannot disagree.

## Where the data lives

**Jobs and events are per-environment.** `pithy_email_jobs` and `pithy_email_events` live in the app `DB` — the same database as the app's own data, scoped to the environment that sent them. A feature branch's sends, history, and tracking are its own.

**Suppression is global.** `pithy_email_suppressions` lives in a dedicated, durable `EMAIL_SUPPRESSIONS` database — one per account, bound the same in every environment. An address that hard-bounced, complained, or unsubscribed must never be emailed from *any* environment, so this is the one resource shared across all of them. It mirrors the shared-DB pattern `@pithy-sh/secrets` uses for `SECRETS` (where the link-signing key lives).

**The reason decides what it blocks.** The list is keyed by address and holds no memory of which message somebody was refusing, so the send path reads the reason against the template's kind:

| reason | elective mail | transactional mail |
|---|---|---|
| `hard_bounce` | block | **block** — the mailbox does not exist. Sending is futile, and hammering dead addresses damages the sending domain for every other adopter on it. |
| `complaint` | block | **block** — continuing after a spam report is how a domain gets blocked outright. |
| `manual` | block | **block** — an operator's deliberate act. |
| `unsubscribe` | block | **send** — an opt-out is a statement about mail somebody chose to receive. A sign-in link is not that. |

Without that last row, one unsubscribe from a weekly digest also withheld the same person's magic link — and passwordless has no password to fall back on, so the account became permanently unreachable with nothing reported at either end. A skipped send is now named, not swallowed: `SendOutcome.suppressionReason` says which reason blocked it, and the job row and event carry it too.

### Suppression is automatic. The database is yours.

**You declare nothing to get it.** Compose `email(...)` and every send is already checked. `enqueue` reads the suppression database off the env you forwarded — the same env it reads `DB` and `EMAIL_SENDER` off — so no config field, no route option, and no constant in your code names `EMAIL_SUPPRESSIONS`. A blocked recipient never becomes a queued send, and the result says why:

```ts
const { jobId, status, suppressionReason } = await emailCapability.enqueue(env, {
  to: "someone@example.com",
  template: "invite",
  payload: { inviterName: "Sam", organizationName: "Acme", acceptUrl },
});
// status === "suppressed", suppressionReason === "hard_bounce" — nothing was sent, and you know now.
```

`runSend` remains the authority, because whether an address is blocked is a question about the instant of sending and a scheduled job is enqueued days before it. The enqueue-time check is not a second gate; it is the caller finding out at the moment it asked, which is the difference between one advisory that reached nobody and three ordinary skips in a log somebody reads next week.

**And it is asked of the template's own kind**, never a restated `"transactional"`. That is the whole of the table above: an unsubscribe from a newsletter must not withhold an invitation, and a check that treated every send alike would start dropping those silently.

**Reading and writing the list is ordinary — it is your database.** `pithy add email` provisions it in your account; the rows are yours. Ask the capability for it and it hands it back, still naming no binding:

```ts
const suppressions = emailCapability.suppressions(env);

// An operator lifts a block on an address the customer has fixed.
await unsuppress(suppressions, "fixed@example.com");
// A support screen asks why a letter did not go.
const reason = await blockingSuppression(suppressions, address, new Date(), "transactional");
// A page of the list, keyset-paged.
const { items, nextCursor } = await listSuppressions(suppressions, { reason: "hard_bounce" });
```

`blockingSuppression`, `suppress`, `unsuppress` and `listSuppressions` are exported from the package root, and `suppressions` is a plain Kysely handle over `pithyEmailSuppressions` for anything they do not cover. Nothing gates it, and nothing here treats the table as state you are not trusted with — the only thing the capability keeps for itself is the wiring.

## A delivered job stops holding its inputs

`pithy_email_jobs.payload` is the caller's template variables, written verbatim so the send Workflow can render without the caller present. For a newsletter that is a send log. For a magic link it is **the sign-in link**, for an OTP it is the code, and for an invitation it is the token — a second, permanent copy of a live credential in a table nobody thinks of as holding secrets. An adopter storing invitation tokens as digests then mailed the plaintext into this table, and the digest bought nothing.

So a delivered job's payload is emptied and stamped with `payloadRedactedAt`, in the same write that marks it `sent`.

**"Spent" means after the last attempt this job will ever make, not after the first.** A payload dropped too early is a message that cannot be resent, which is a worse failure than the one being fixed. `sent` is the only status that qualifies, and every other outcome keeps its inputs on purpose:

| status | payload | why |
|---|---|---|
| `sent` | **dropped** | The message is out. It is also the one status a retry is already refused for — retrying a delivered job is a duplicate email to a real person — so nothing can ever need those inputs again. |
| `failed` | kept | `POST /email/jobs/:id/retry` exists for exactly this row, and it re-renders from the payload. |
| `suppressed` / `bounced` | kept | Nothing was delivered. A manual block can be lifted. |
| `pending` / `scheduled` / `sending` / `undispatched` | kept | The send has not happened yet — and for `undispatched`, not until a host worker exists to claim it. |

**It is the default for transactional templates, and the line is the category rather than the kind.** The kind answers "may this be refused"; this question is "are these inputs a one-time credential". `testerNudge` is the template that proves they are different axes — it is *elective*, because somebody may say stop chasing me, and its CTA is an opt-in URL that authenticates a tester. Keying on the kind would have left exactly that one live. A marketing payload is copy authored for a batch, carries no per-recipient credential, and answers the real question "what did those forty thousand people receive", so `newsletter` and `marketingCampaign` keep theirs. There is no per-template override: no template needs one today, and an escape hatch nobody uses is where the bug comes back.

**What is kept is what an operator asks.** Was this sent — `status`, `sentAt`, and a `sent` event. To whom — `toAddress`. What was it — `template`, `category`, and the rendered `subject`. Did it arrive — `messageId`, plus the `open`/`click`/`bounce`/`complaint` events tied to it. The log has lasting value; the inputs are what carried the risk. One boundary worth naming: the stored subject is rendered *from* the payload, so a template that put a credential in its subject line would keep it. None does, and none should — a subject is a summary, and it is the one part of a message that shows up in a notification on a locked screen.

Nothing about this is visible through the management routes, because the payload was never projected there in the first place.

## Management routes

Silent email failure costs a signup. These are the routes a dashboard reads to notice, mounted under `basePath` (default `/email`, set it in `email({ basePath: "/mail" })` and the manifest follows).

Every one is `control-plane` and **default-denied**: an M2M admin surface for a management client the adopter connected, verified by the core seam. There is no bearer or session surface here — a recipient's only routes are the click, open, and unsubscribe callbacks, which keep their fixed `/_pithy/email` prefix because those URLs are already minted into mail nobody can recall. With the control-plane seam uncomposed, all six answer 403.

| Method | Path | Scope |
|---|---|---|
| GET | `/email/jobs` | `email:jobs:read` |
| GET | `/email/jobs/:id` | `email:jobs:read` |
| POST | `/email/jobs/:id/retry` | `email:jobs:retry` |
| GET | `/email/suppressions` | `email:suppressions:read` |
| POST | `/email/suppressions` | `email:suppressions:write` |
| POST | `/email/suppressions/remove` | `email:suppressions:delete` |

Five scopes, not one admin flag, because these fail in five unrelated directions. Reading jobs discloses who you mailed. Retrying one sends real mail to a real person under your domain and DKIM. Reading suppressions discloses, in one list, every address in the project that ever bounced or opted out — across every environment, since that database is global. Adding a suppression is a targeted denial of service: a `manual` block stops every message to that address, transactional included, so that person never gets another magic link. Removing one re-opens sending to somebody who reported spam. Scopes match exactly, with no prefix or wildcard rule, so a tool that retries stuck receipts never also holds a suppression write.

**The template payload is never projected. Anywhere.** A `magicLink` job's `payload` holds a working sign-in URL and an OTP job's holds the code, so returning it on a read scope would turn the least privileged credential here into account takeover. There is no flag for it.

**The job list masks the recipient (`ad***@example.com`); the detail route returns the whole address.** That is a bulk-harvest control, not anonymization: it takes the cost of exporting the list from one request per hundred addresses to one request per address, each individually audited. The domain survives masking, because that is what you read a deliverability problem off. The suppression list is the deliberate exception — an address *is* the record there, which is why reading it is its own scope.

**Every call is audited, reads included** (`email/jobs_read`, `email/job_read`, `email/job_retried`, `email/suppressions_read`, `email/suppression_added`, `email/suppression_removed`), through the `@pithy-sh/audit` seam. A block is silent to everyone it affects, so the trail is the only record it happened.

Both lists are cursor-paginated on `(createdAt, id)`, never offset — `pithy_email_jobs` is written to on every send, so an offset page shifts under whoever is reading it.

A retry is only ever accepted for a `failed` job, and only after re-checking the suppression list: `attempts` is reset (or `runSend`'s budget would end it again on the first retryable error), the row goes back to `pending`, and the send Workflow is dispatched. A dispatch that fails is reported, not fatal — the every-minute scheduler re-drives the row within the minute. A manual block is always recorded as `reason: "manual"`; the other three reasons are facts the system observed, and a management client observed none of them.

## Feature / staging / prod

Each environment sends its own jobs, recorded in its own app DB. They all read and write **one** shared `EMAIL_SUPPRESSIONS` database, so an unsubscribe collected in production also stops staging and feature builds from emailing that person.

Inbound mail is the asymmetric part. **Cloudflare Email Routing binds one Worker per domain** — there is no per-environment inbound worker. So bounce/complaint mail routes to a single (production) app worker. That worker writes the **shared** suppression list, which is what every environment honors — so suppression is correct everywhere. Cloudflare also auto-suppresses hard bounces account-wide at the platform, and returns `permanent_bounces` synchronously on send (captured in the originating environment). Each send is stamped with `X-Pithy-Env` and `X-Pithy-Job` headers so the inbound worker can attribute a message; updating a *specific* job row across environments is best-effort (the one inbound worker can't bind ephemeral feature DBs), while suppression — the safety-critical part — is always global.

## Sending domain

You send from a domain you onboard onto Cloudflare Email Service, and Cloudflare validates the `From` **header domain** against exactly what you onboarded — onboard `example.com` and `From` must be `@example.com` (e.g. `noreply@example.com`); a sibling subdomain or the apex is rejected (`email.invalid` / `E_SENDER_NOT_VERIFIED`) until it too is onboarded.

**Recommendation: onboard your apex domain** (`example.com`) and send as `noreply@example.com`. The `From` is the only sender identity recipients and spam filters actually see, so a recognizable brand-domain address is trusted and engaged with far more than mail from an obscure subdomain — and, as below, onboarding the apex costs nothing in compatibility. Reach for a subdomain (`mail.example.com`) only when you deliberately want to isolate one stream's reputation — e.g. high-volume marketing kept off your transactional domain.

### Why the apex is safe to onboard

A common worry is that onboarding the apex will disturb your existing mail — your MX records (Google Workspace, etc.) or another sender (Amazon SES). It doesn't, because email **authentication** and email **receiving** are independent systems, and authentication never checks the visible `From` domain directly. It checks two *other* identifiers, and DMARC needs only one of them to **align** with the `From`:

- **SPF** authenticates the envelope **MAIL FROM** (Return-Path), not the `From` header. Cloudflare uses its **own return-path subdomain** (`cf-bounce.example.com`), so SPF is evaluated there — never on your apex SPF record — and DMARC-aligns to `example.com` by **relaxed** alignment (same organizational domain).
- **DKIM** is signed with `d=example.com` using Cloudflare's own selector (CNAMEs it adds), so it passes *and* aligns with the `From`.

So onboarding the apex for **sending** only adds DKIM CNAMEs and a return-path subdomain — both additive. It does **not** touch your **MX**, so inbound mail keeps flowing to your existing provider untouched. (Email *Routing* — Cloudflare's inbound product — is the one that takes over MX; you simply don't enable it on the apex.) Multiple senders coexist without an SPF fight because each authenticates on a **different** MAIL FROM domain and a **different** DKIM selector: your apex SPF stays for your existing provider, SES rides on its own MAIL FROM subdomain, and Cloudflare rides on `cf-bounce.example.com`.

A delivered apex message shows exactly this: `From: noreply@example.com`, `mailed-by: cf-bounce.example.com` (SPF), `signed-by: example.com` (DKIM) — all three reconciled by DMARC alignment.

### Steps

1. In the Cloudflare dashboard, open **Email** → **Email Sending**, **Add a domain**, enter `example.com` (or run `wrangler email sending enable example.com`). For a zone already on Cloudflare, Cloudflare adds the DKIM CNAMEs and the return-path subdomain automatically; for a zone elsewhere, it shows the records to add. Your apex SPF and MX are left alone.
2. Wait for the domain to show **Verified** in the Email Sending dashboard. Until then, `From: @example.com` is rejected.
3. To classify bounces/complaints in your own worker, add **Email Routing** on a dedicated **subdomain** (e.g. `bounce.example.com`, never the apex, so your provider keeps the apex MX — but read [Enabling Email Routing without losing your apex MX](#enabling-email-routing-without-losing-your-apex-mx) first, because Cloudflare configures the apex before it lets you pick a subdomain) pointing at the production app worker — or skip it and rely on Cloudflare's account-wide auto-suppression plus the synchronous permanent-bounces this package already captures (one inbound worker per domain — see "Feature / staging / prod").

### Enabling Email Routing without losing your apex MX

"Enable it on a subdomain, never the apex" is the right instruction and an incomplete one, because **Email Routing is a zone-level feature and you cannot start below the zone.**

The zone is the master record keeper: every DNS record for a domain *and all its subdomains* lives in that zone, unless a subdomain is delegated to a zone of its own. So Email Routing is configured on a zone, and it configures that zone's **apex** by default — automatically creating *and locking* apex MX records plus an apex SPF `TXT`, before you have chosen anything. If that apex carries real mail, it has already moved.

Which apex you end up configuring is therefore decided entirely by **which zone you added**. Two ways to end up in the right place.

**A — a delegated subdomain zone.** Add `bounce.example.com` to Cloudflare as its own zone, by NS delegation from the parent, and enable Email Routing there. That zone's apex *is* the subdomain, so the records Cloudflare locks are exactly the ones you wanted. The parent zone is never touched, and there is nothing to clean up. Prefer this when you control the parent's DNS and don't mind a second zone.

**B — a subdomain inside the parent zone.** Enable Email Routing on `example.com` itself and add `bounce.example.com` as a routing subdomain. This is the path most people take, and it is the one with the trap: the zone's apex is your real domain, so Cloudflare configures your real domain first and you undo it afterwards. The order matters:

1. Enable Email Routing on the zone. Cloudflare adds and locks **apex** MX records and an apex SPF `TXT`.
2. Add your subdomain (`bounce.example.com`) in the Email Routing UI. Cloudflare adds MX and SPF for the subdomain.
3. **Unlock the apex records** from step 1. Unlocking is only ever about the apex.
4. On the **DNS** page, delete the **apex** MX records and the **apex** SPF `TXT`. Leave every subdomain record alone.

Between steps 1 and 4 your apex MX belongs to Cloudflare. Do this on a domain that is not carrying real mail, or accept a window of redirected inbound.

**Never hand-edit the subdomain's records.** They are created automatically when you add the subdomain, and they cannot be unlocked — by design, because Email Routing owns them. Over the API they carry no `locked` field at all; they are marked `meta: { email_routing: true, read_only: true }`.

**To stop routing a subdomain, delete the subdomain in the Email Routing UI.** Its records go with it, cleanly. There is no DNS surgery in that direction — the apex cleanup above exists only because Cloudflare configured the apex before you got to choose.

**Do not delete `cf2024-1._domainkey`.** It is Email *Sending*'s DKIM key and has nothing to do with routing — deleting it breaks outbound signing, not inbound mail. It sits at the zone apex and looks like part of the same cleanup. It isn't.

#### Afterwards the dashboard reports it wrong

Once the apex records are gone, the zone's Email Routing page says **Disabled** and its DNS records read **Not Configured**. Neither is a problem, and only the second is even true — the apex genuinely has no routing records, because you deleted them on purpose. The signal that matters is on the same page: **"1 subdomain configured"**.

The API is clearer, and it is what `pithy` reads:

```
GET /zones/{zone_id}/email/routing   →   { enabled: true, status: "unconfigured" }
```

**`enabled` is the truth. `status` is apex-only and will read `unconfigured` forever in this topology.** Never gate anything on `status`.

One more default worth knowing: every zone carries a catch-all rule — no name, priority `2147483647`, `matchers: all`, `actions: drop` — created by Cloudflare whether or not you configure anything. Its `enabled` flag is a reliable "is routing on for this zone" signal. It also means that **until you add a Worker rule, mail to your routed subdomain is accepted and silently discarded.** A test message that vanishes at this stage is the default behaving correctly, not a fault.

## The suppression database, and provisioning

A dedicated `EMAIL_SUPPRESSIONS` database is the default and the recommendation. You *can* point its binding at the same `database_id` as your production app DB — the tables are `pithy_email_*`-prefixed and won't clash — but keeping it separate avoids coupling throwaway feature DBs to production and keeps migrations and backups clean.

`pithy email provision` does the live setup: it creates the shared suppression database, migrates it, and deploys the per-environment email worker (send + scheduler Workflows, the every-minute cron, the `send_email` binding), resolving each environment's app-DB id and `BASE_URL` from `wrangler.jsonc` and its secrets-DB id from a live lookup. It mints **no** CF API token — the worker sends through the binding and reads its signing key through the `SECRETS` bindings (the only token is your bootstrap `CLOUDFLARE_API_TOKEN`, used to deploy, never given to the worker). Run `pithy secrets provision` first (the worker reads its signing key from the secrets DB), and `pithy secrets create email-link-signing-key` to mint that key. Pass `--routing-zone`/`--inbound-address`/`--app-worker` to also create the inbound bounce routing rule (enable Email Routing on a subdomain first — never the apex). `pithy email deprovision` removes the workers (and, with `--suppression`, the shared DB). Domain onboarding remains a one-time account action (above).

### The inbound routing flags

`--routing-zone`, `--inbound-address`, and `--app-worker` together create the **one** Email Routing rule that delivers bounce/complaint mail to your worker. They're opt-in (omit them and provisioning skips routing), and all three are required together:

- **`--routing-zone`** — the Cloudflare **Zone ID** (the 32-char id on the zone's Overview page, *not* the domain name) of the zone whose inbound mail is routed. **Email Routing must already be enabled on this zone**, which points MX at Cloudflare — so route a **subdomain** (e.g. `bounce.example.com`), never your apex, or you'd move your real inbound mail off your provider. Enabling routing configures the apex *first* whether you want it or not: see [Enabling Email Routing without losing your apex MX](#enabling-email-routing-without-losing-your-apex-mx) before you touch a domain that carries real mail. Note this id is the **zone**'s — with a routed subdomain inside a parent zone, that is the parent's id, not the subdomain's.
- **`--inbound-address`** — the exact recipient address the rule matches, on that routed zone (e.g. `bounce@bounce.example.com`). Any mail addressed to it is handed to the app worker's `email()` handler, which classifies it (bounce / complaint / auto-reply) and updates suppression + events.
- **`--app-worker`** — the deployed name of your **production** app worker — the one running `createEntrypoint`, which exports the `email()` bounce handler (e.g. `pithy-app-prod`). This is your app worker, not the prebuilt email/workflow worker.

Note that Cloudflare already auto-suppresses hard bounces account-wide and reports `permanent_bounces` synchronously on send (which this package captures), so the routing rule is for when you want DSNs/complaints **classified in your own worker** — e.g. to record per-campaign bounce events for analytics. Verifying the rule end to end is tracked in [#47](https://github.com/pithy-sh/pithy/issues/47).

Verify a project's setup end to end with `pithy email test --to you@example.com [--template welcome]` — it renders a sample of any template through your configured theme and from-address and sends it, so you can see the result land.

## Pluggable sender (future providers)

Sending is abstracted behind one seam — `EmailSender` (`send(message): Promise<EmailSendResult>`). Today two implementations satisfy it: the in-Worker `send_email` binding (the default) and the out-of-Worker REST manager `@pithy-sh/cloudflare`'s `cf.email().send()` (used by `pithy email test`). The whole send path (`runSend`) is provider-agnostic — it takes a `sender`, not a Cloudflare binding. So a future `provider: "cloudflare" | "ses"` config flag that selects a different `EmailSender` (e.g. an Amazon SES implementation) is a clean, additive change: it would slot in at that seam, with the provider's credentials living in `@pithy-sh/secrets` and its own bounce path replacing the Email Routing handler. The rest of the capability — jobs, scheduling, templates, tracking, suppression, analytics — is unchanged by the choice of sender. Not built today, but the architecture is ready for it.

## Themes

Pick an off-the-shelf theme to bootstrap — `saffron` (Pithy default), `midnight`, `forest`, or `rose` — each a matched light/dark palette pair so dark mode looks intentional. Override piecemeal with `accent`, or wholesale with full `light`/`dark` palettes.

```ts
email({
  fromAddress: "noreply@example.com",
  baseUrl: "https://api.example.com",
  theme: "midnight",        // a preset…
  accent: "#7C3AED",        // …with an accent override
  // light: { background: "…", cardBackground: "…", text: "…", textMuted: "…", textSubtle: "…", separator: "…" },
  // dark:  { … },          // …or a full custom palette
})
```

**Logos must be publicly hosted PNGs.** `logoUrl` (light) and `logoDarkUrl` (dark) are `<img src>` values, and mail clients — Gmail especially — do not render `data:` URIs or inline base64. Host both wordmarks at an absolute HTTPS URL (e.g. `https://pithy.sh/email/pithy-wordmark-email.png` and `…-dark.png`) and point the config at them; leave them empty to render the app name as text. The dark wordmark is swapped in under `prefers-color-scheme: dark`.

## Analytics (and how bounces get there)

Every recipient action is appended to `pithy_email_events` in the **per-environment app DB**, each row carrying the job's `campaignId`. `campaignStats(db, campaignId)` aggregates them into a batch's funnel:

```ts
import { campaignStats } from "@pithy-sh/email/src/index";
const s = await campaignStats(db, "spring-launch");
// { sent, open, click, bounce, complaint, unsubscribe, suppressed, failed }
```

Where each event is written — and so how it reaches analytics:

- **`sent`** — by the send Workflow, when the Email Service accepts the message.
- **`open` / `click` / `unsubscribe`** — by the callback routes. Their links point at the **sending** environment's app worker (built from that env's `BASE_URL`), so the events land in the *same* app DB the job lives in. Attribution is automatic.
- **`bounce` / `complaint`** — two paths. A **synchronous** permanent bounce returned on send is recorded immediately in the originating environment. An **asynchronous** bounce/complaint arrives as inbound mail to the single production inbound worker; it matches the job by the original `Message-ID` (against the stored send `messageId`), then writes a `bounce`/`complaint` event **with the job's `campaignId`** and marks the job `bounced`. So a production campaign's bounces sit in `pithy_email_events` next to its opens and clicks, and `campaignStats` counts them together.

The one limit is cross-environment async bounces: because Cloudflare binds one inbound worker per domain, that worker only reaches the production app DB. A staging/feature campaign still gets its own opens, clicks, and unsubscribes (their links point back to that env) and its synchronous send-time bounces, but an *asynchronously* routed bounce for a staging job lands as a global suppression rather than a staging-DB event. Production campaigns — the ones that matter for batch analytics — get the full funnel.

## Live testing

`bun run test` covers everything against Miniflare with real D1. A live suite (`bun run test:integration`) renders with the real engine and sends through the Cloudflare Email Service to a real recipient. It is gated: it needs Cloudflare credentials (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) for an account with an onboarded sending domain **and** `PITHY_EMAIL_LIVE=1`, and the API token must carry the **Email Sending: Edit** permission — a general account token authenticates but the send endpoint rejects it (`code 10000`). Skipped by default. Set the sender and recipient with `PITHY_EMAIL_FROM` and `PITHY_EMAIL_TO`.

## Templates

`magicLink`, `otp`, `welcome`, `securityAlert`, `invite`, `passwordChanged`, `operationalNotice`, `supportReply` (transactional); `newsletter` (iterable articles), `leadCapture`, `marketingCampaign`, `testerNudge` (elective). Each ships a Zod payload schema — the validated, documented input contract — plus a `category` and a `kind`. Templates are precompiled Handlebars (no runtime eval in the Worker) and render both HTML and plain text.

**The kind is declared by the template, never passed by a caller.** `transactional` answers something the person just did — a sign-in link, an invitation they are waiting on, a security notice. `elective` is mail somebody chose to receive. Only elective templates render an unsubscribe link, and only they carry `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058 one-click, which the callback route accepts as a POST). Transactional templates carry neither, structurally: there is no argument a call site can pass to put an opt-out on a sign-in link, because `List-Unsubscribe` on a login message publishes a mechanism for disabling authentication — and Gmail's and Yahoo's bulk-sender rules ask for one-click opt-out on *promotional* mail, which this is not.

The two axes are separate on purpose. The category says what a message *is* (and a `marketing` one cannot render at all without an unsubscribe link); the kind says whether it may be *refused*. `testerNudge` is the case that proves they differ — transactional in style, elective in consent, because a testing program chases one person repeatedly for a fortnight.

### The operational notice

*Something about your own infrastructure changed or needs attention.* A rotation that failed, a release with a security fix, a connection that stopped answering, a job that has been retrying for a day — every capability in this kit produces facts an operator would want told without signing in, and they all share one form: what happened, to what, when, how serious, and one place to act on it.

```ts
await enqueueEmail(deps, {
  to: "ops@acme.test",
  template: "operationalNotice",
  payload: {
    severity: "warning",                                     // info | warning | critical
    summary: "A secret has not been rotated in 90 days",
    thing: "STRIPE_SECRET_KEY",
    when: "18 June, 14:02 UTC",
    detail: "Rotation is overdue. The old value keeps working until the new one is in place.",
    facts: [{ label: "Environment", value: "prod" }],
    actionUrl: "https://acme.test/secrets/stripe-secret-key",
    actionLabel: "Rotate it",
  } satisfies OperationalNoticePayload,
});
```

**It is not `securityAlert`.** That template is about a session — it describes a sign-in and closes with *"if this was you, no action is needed"*, which is the opposite of what an overdue secret means. This one assumes the recipient is the operator and that the fact is true. There is nothing to confirm, only something to do or to know.

**Severity is expressed, not flattened.** Each level owns a word — `Notice:`, `Action needed:`, `Critical:` — and that word leads the subject line, so the urgency is legible in an inbox list before anything is opened. It is repeated in the body and in the plain-text part, and *then* reinforced by color, which is the order that survives a text-only client, a monochrome screen, and a reader who cannot tell the red one from the amber one. A design where the only difference between "a release is out" and "sign-in is broken" is a hex value has flattened them, and a reader who cannot see that difference learns to ignore both. The severity has no default: a capability that forgot the field would otherwise send an outage at the volume of a release note.

**It renders with no link-signing key.** The template is transactional, so it never needs an unsubscribe link and never mints a token; nothing about it depends on configuration a project might not have finished. An operational notice that cannot render is the notice you needed most.

The `actionUrl` is optional, and deliberately so. A caller with nowhere to send somebody would otherwise invent a link, and a dead link in a critical notice is worse than no link — the summary, the thing and the facts stand on their own.

### The registry is closed

There is no `registerTemplate`. An adopter composing `email` sends the templates above and no others. That is a decision, and this is the argument for it — written down here because the alternative is equally defensible and neither position was on record.

**The runtime settles the first half.** The Workers runtime forbids code generation entirely — no `eval`, no `new Function`, not even at isolate startup — so `Handlebars.compile()` cannot run where the mail is sent. Every body in this package is turned into a *spec* by `scripts/precompile.ts` at build time and revived with `Handlebars.template(spec)`, which never evaluates a string. An open registry therefore cannot accept a template; it can only accept a precompiled spec, built by the adopter's own Handlebars, in their own build. Handlebars refuses a spec whose compiler revision differs from the runtime's, so the kit would be publishing a version-locked build artifact format as its extension surface — and the failure mode of getting it wrong is every email failing to render at once, at the next unrelated dependency bump.

**Two things would stop being structural.** The kind would go back to being a claim: [#281](https://github.com/pithy-sh/pithy/issues/281)'s fix rests on a call site being *unable* to assert that a message is transactional, and a registerable template makes that assertion writable again — mail that ignores an unsubscribe, sent over the adopter's own DKIM signature, charged to their own sending domain. And escaping here is a property of the fixed bodies, not of a convention: `testerNudge` is safe because its supplied words render through `{{this}}`, and one `{{{triple}}}` in a supplied body is a phishing page on a domain the recipients already trust.

**What the closure obliges in exchange**, because a closed registry with no obligations is just a wall:

- **A missing shape is a bug in the kit, not a gap in your project.** This template exists because `pithy-sh/dashboard` had notification settings switched on and nothing to send. File the shape; it gets built.
- **Where the words are yours, the template takes them as payload.** `supportReply` (a human's letter), `testerNudge` (a cohort's nudge) and `operationalNotice` (any fact about your own infrastructure) are all the same pattern: the kit owns the shell, the caller owns the copy. Between them they cover most of what a bespoke template would have been for.
- **Nothing here locks the door.** `EmailSender` is an interface, and a project that genuinely must render its own body can compose one and send through it. That is an escape hatch, not a recommendation: it leaves the job table, the retries, the tracking callbacks and — the part that matters — the suppression check behind. Anything sent that way is mail this capability cannot stop going to an address that hard-bounced or reported spam, and the damage lands on the sending domain every other message shares.

The day the runtime allows a spec to be handed across a version boundary safely, this is worth revisiting. Until then, opening the registry would trade two structural guarantees for an extension point that breaks on a patch release.
