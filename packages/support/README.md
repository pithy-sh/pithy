# @pithy-sh/support

A support inbox that lands mail — and your signed-in users' own reports — in your own D1, classifies both on your own Workers AI binding, and links each sender to the account and purchases your app already knows about.

Support is the employee a solo developer cannot hire. Every piece needed to build one was already in the catalog — inbound mail, R2, identity, payments, audit — and nothing composed them. This does.

You own the mail, the database, the bucket, and the inference. There is no Pithy-operated service in the path, and there is nothing here that a hosted dashboard unlocks: every route is reachable with a credential you issued, whatever anyone pays.

## The MX constraint, stated plainly

**Cloudflare Email Routing takes over a zone's MX.** Enabling it on `yourdomain.com` moves all of your real inbound mail off whatever provider handles it today.

So `support@yourdomain.com` is only available to you if that domain carries no other mail. Everyone else uses a subdomain — `support@help.yourdomain.com` — which works identically and is slightly less polished. This is the single most important thing to know before running anything below, which is why it is at the top rather than in a footnote.

## Add it

```
pithy add support
```

That wires `support()` into `pithy.config.ts`, adds the manifest bindings, and runs the migrations. Until you set `inboundAddresses` the inbox is inert — it ignores every message and says so once in the log, rather than quietly storing mail from an address nobody chose.

## Provision it

```
pithy support provision --routing-zone <zone-id> --inbound-address support@help.example.com --app-worker api
```

One command, idempotent, safe to re-run. It creates the `SUPPORT_BUCKET` R2 bucket, deploys the prebuilt classification worker for each environment, and creates the Email Routing rule that delivers your support address to your app worker. `--json` prints one machine-readable line, so CI and agents drive the same command a human does.

The routing flags are all-or-nothing and deliberately explicit. Creating a rule on the wrong zone would move your real mail, and that is not a mistake a provisioning command gets to make on your behalf. Leave them off and everything else still provisions; add the rule when you have decided.

Teardown is `pithy support deprovision --routing-zone <zone-id>`, which removes the routing rule first — so mail stops arriving before the workers that would have handled it go away — and leaves your stored correspondence alone unless you pass `--storage`. The zone is named for the same reason it is on provision: a rule is addressed through its zone, and this command will not go looking through your domains for one. Leave it off and the rule stays, which the command tells you.

## Configure it

```ts
support({
  // The addresses this inbox claims. Use a subdomain, never your apex. See above.
  inboundAddresses: ["support@help.example.com"],

  // Classification runs on YOUR binding, on YOUR bill.
  ai: { enabled: true, model: "@cf/meta/llama-3.1-8b-instruct" },

  // Your own categories, merged over the eight that ship.
  categories: defineSupportCategories({
    tournament_dispute: "The sender is contesting a tournament result, a disqualification, or a prize.",
  }),

  // Bounds on a public write endpoint. Because that is what a public address is.
  guard: { maxRawBytes: 2_000_000, maxPerSenderPerHour: 20, maxPerHour: 500, archiveSpam: true },
})
```

## How a message becomes a thread

Mail arrives at your app worker's single `email()` entry, which fans it to every capability that handles inbound mail. Support claims what is addressed to it — **on the SMTP envelope recipient, never on a `To:` header**, because anyone can put your support address in a header on a message routed somewhere else.

From there: the guard bounds it, `postal-mime` parses it (multipart and attachments included), the HTML is sanitized through the runtime's own parser, the raw MIME goes to R2 unchanged, and the row lands in D1. Only then is classification dispatched — as a Workflow, because an inbound handler has a tight CPU budget and a model call does not fit in it. A model that is slow or briefly down must never take the persistence of somebody's support request with it.

Threading is on `In-Reply-To` and `References`, never on the subject. Subject matching is what puts two unrelated people who both wrote "Refund" in one thread, and what splits a real conversation the moment a client localizes `Re:` to `Aw:`.

## Writing in from inside the app

`POST /support/feedback`, wearing `requireAuth()` and nothing weaker. It opens a thread, or appends to one the caller already owns — same table, same classifier, same taxonomy, same console. There is no second inbox, because a support person with two consoles has the whole conversation in neither.

**This is the channel where the mail path's hardest problem does not exist.** Two hundred lines of `inbound/authenticity.ts` earn the right to say a thread belongs to a customer, because `From:` is an unauthenticated claim and decorating a spoofed thread with somebody's real billing history is the opening move of support-driven account takeover. An in-app submission has no `From:` to spoof. The session is the identity, and `requireAuth()` proved it before the handler ran.

So the thread records **how** it came to name an account, not just whether to believe it:

| `accountLinkSource` | What it means |
|---|---|
| `session` | An authenticated request proved it. The account *is* the caller. |
| `email_address` | Matched against the address in a `From:` header nobody proved. |
| `null` | No link — the address belongs to nobody with an account. |

A console must render those differently. The same operator action — a refund, a password reset — follows from very different evidence, and a single boolean cannot say which one is on screen.

`channel` (`email` or `app`) rides on the thread and on every message, and the inbox filters on it. It is per message as well as per thread because the two genuinely differ: one app thread can hold **an answer that was mailed and an answer that was not**, and on an outbound row `channel` is how the answer was delivered. A mailed reply to an app thread is `email`, and the submission is minted a `Message-ID` on the way in, so when they answer that reply their mail client's `References` finds the thread instead of opening a new one.

`emailJobId` follows from that and carries no information of its own: it is present exactly when a row is `outbound` and `email`. Ask `channel` whether an answer went out — never the absence of a job id, which would mean both *this arrived* and *this is waiting in the app*.

The app supplies what the user should not have to type — screen, build, platform, environment, locale — and that set is **closed**. An undeclared key is refused rather than stored, because the risk of an open bag is an adopter passing their whole client state through it and quietly landing a customer's data in an inbox a console renders.

### What the submitter said, beside what the classifier decided

A submission may carry `declaredCategory` — the answer to your screen's own chooser. It lands in its own column, next to `category`, and **the two are never folded into one**.

| Column | Whose | Written |
|---|---|---|
| `declaredCategory` | The person writing. A claim. | Once, when the thread opens. Never again, and never by the classifier. |
| `category` | The model. A judgment. | On every classification — a first run, a retry, a manual reclassify, a post-upgrade backfill. |

**One column with a precedence rule loses a fact, whichever rule you pick.** A classification is idempotent by construction and overwrites `category` unconditionally, so a claim sharing that column is gone the first time a model looks at the thread; refusing the model's write instead loses the judgment. And a `categorySource` beside a single column only names which of the two is currently there — it cannot hold both. What an operator triaging an inbox actually needs is the pair, and specifically the pair when it disagrees: *they filed it as billing, the model calls it a bug report* is the most useful row on the screen, and no single column can say it.

`GET /support/threads` filters on either, independently. Filtering on both is asking for the threads where they agree. On a project with `ai: { enabled: false }` — no Workers AI binding, nothing provisioned — `category` is `uncategorized` forever and the declared one is the only category anybody stated, which is exactly the deployment that made this necessary.

**A key outside your effective taxonomy is refused, not stored and not downgraded.** Stored, the column becomes a client-writable vocabulary and your filters grow a long tail of `Billing`, `billng`, and one-offs nobody declared. Downgraded to `uncategorized`, a broken chooser becomes indistinguishable from somebody who genuinely chose nothing. The model gets the fallback because a model cannot be told it was wrong; a client can, and a 400 is how it is told — your chooser was built from the taxonomy you declared, so a value outside it is your client's bug.

Sent alongside `threadId`, it is refused too. A conversation carries what it was filed under; ignoring a second claim is a chooser that does nothing, and honoring it lets a follow-up rewrite the premise the thread was opened on — the way `subject` deliberately cannot.

### Your own authorization on the submission route

`POST {base}/feedback` takes a session and same-origin, and **nothing else, permanently**. Writing to support must not be role-gated or it stops being a general intake: the person who most needs to reach you is often the one whose access is broken.

If your own account model makes some submissions act-on-behalf-of — an application made for an organization, which a member may not make — put that check in your `app` capability's middleware, over your own path:

```ts
defineCapability({
  name: "app",
  middleware: [
    (app) => {
      app.use("/support/feedback", async (c, next) => {
        // Signed out? Pass it through — the route's own gate answers 401. A 403 here would tell
        // somebody who was never signed in that they are forbidden.
        if (c.var.auth && !(await mayActForTheOrganization(c))) {
          throw new ForbiddenError({ message: "An owner or an admin applies on the organization's behalf." });
        }
        await next();
      });
    },
  ],
  …
});
```

Every capability's middleware mounts before any capability's routes, and your `app` composes last — so yours runs **after** `@pithy-sh/auth` has resolved the session and **before** this capability's `requireAuth()`. Write the path from the `basePath` you configured: a mount point you moved and a middleware path you did not is a gate that silently stops covering anything.

```ts
support({
  submission: {
    // Bounds on a surface that is authenticated but still untrusted.
    maxBodyChars: 10_000,
    maxPerAccountPerHour: 10,
    attachments: {
      maxBytes: 5 * 1024 * 1024,
      maxCount: 3,
      allowedContentTypes: ["image/png", "image/jpeg", "application/pdf"],
    },
  },
})
```

**The attachment bounds are stated here rather than inherited, and that is deliberate.** The mail path caps size and count and says nothing about type, because refusing an unexpected type would lose a customer's bug report. A direct upload from a browser is a different surface with a different answer: the useful payload is a screenshot, and an allowlist is both possible and worth having. Inheriting the email numbers would have shipped a 10 MB any-type upload endpoint as a side effect of a setting somebody tuned for their inbox. Bytes are stored exactly as the mail path stores them — server-derived opaque key, `application/octet-stream` on the object whatever was declared.

**Abuse here is attributable and revocable, which is what makes ten an hour a safe number.** A mail flood is anonymous; a submission carries an account you issued and can disable. The bound is counted per account over the same sliding hour the mail guard uses, and **only against app submissions** — neither channel may starve the other. A busy inbox must never stop a user reporting the outage, and heavy in-app feedback must never lock a paying customer's email out.

## Reading it back

`GET /support/feedback` and `GET /support/feedback/:id` hand a submitter their own conversations and nothing else. Scoped to their account **and** to the app channel: a mail thread linked to them was matched from an unproven header, and treating that as ownership would turn the mail path's known weakness into a read primitive.

Somebody else's thread answers **404, not 403**. The two are the same answer on purpose — a 403 confirms the id names a real conversation, and on an inbox of other people's correspondence that confirmation is itself the disclosure.

The submitter's view is built from scratch rather than by nulling fields on the operator's, because a projection that starts from the operator's shape leaks the next column somebody adds. They see their words, the answers, and whether it was resolved. Never the classification — a machine's judgment about them, and `angry` rendered back to the person it describes is its own kind of disaster — never the priority, never an operator's private flags, never another account's anything.

Set `submission: { enabled: false }` and the routes are not mounted at all. They answer 404, which is the honest answer for a feature a deployment does not have; a 403 would say "this exists and you may not use it".

## What the browser is told

A submission form is the one thing on this capability a browser calls, so support publishes a client-safe projection like `auth`, `payments` and `turnstile` do. Import it and narrow on `enabled` — never write the path down.

```ts
import support from "virtual:pithy/support";

if (support.enabled) {
  await fetch(`${support.basePath}/feedback`, { method: "POST", /* … */ });
}
```

`basePath` is the load-bearing field: move the mount and the client follows, instead of posting to an address that answers 404 — which reads to the person pressing Send as *the request did not go*, indistinguishable from a server that is down. Beside it are the bounds a compose form should hold somebody to before it lets them send: `submission.maxSubjectChars`, `submission.maxBodyChars`, and `submission.attachments` (`maxCount`, `maxBytes`, `allowedContentTypes`, or `null` when attachments are off and no file picker should render).

**`{ enabled: false }` when `submission.enabled` is false**, because the routes are then not mounted and a browser has nothing here to call. A screen branches once rather than guarding down two levels.

**The taxonomy is deliberately not projected.** A category's value is the instruction a model reads and it lands in the prompt verbatim — prompt input written for a classifier, not copy for a chooser, and an adopter's UI wants its own words for a category either way. Nor are the inbox addresses, the canned replies, the classifier settings, the mail path's bounds, or `maxPerAccountPerHour` — a rate no client can pre-enforce honestly, since the count lives in D1 and the server's refusal is the only truth about it.

## Classification

Three axes from one call — category, priority, sentiment — because together they make a sortable inbox rather than a labeled one.

The inference lands on your Cloudflare bill, where it belongs and stays small. Your customers' support mail never leaves your infrastructure: *your support AI runs on your own hardware, and we never see a customer email.* That is literally true, and it is the strongest thing this project can say about any feature.

**Model output is validated against the declared enum, falling back to `uncategorized` on a miss.** A text model will always produce a plausible-sounding label, and an invented one silently poisons every filter downstream. The model id and confidence are stored with every classification, and the history is append-only — so a reclassification pass after a model upgrade can tell which rows came from which model.

The taxonomy is federated. Eight categories ship, chosen to map to *action* rather than topic; you add your own with `defineSupportCategories`, and a category's description is prompt input read by the model verbatim, not documentation.

## Derived only — no coordination state

Everything the capability produces is computed from immutable inbound mail. A wrong classification is recomputed, not repaired. Nothing can corrupt and nothing needs defending.

**No assignment. No status workflow.** A status field is a state machine, and state machines attract SLAs, escalation, and reporting. That is a ticketing product and it is explicitly not this.

Two deliberate exceptions. Per-viewer flags — read, snoozed — because nobody coordinates around them. A live snooze hides a thread from **that viewer's** listing and nobody else's, and expiry is evaluated on read, so a snooze ends on its own with nothing having to sweep. And `archived`, one shared boolean meaning done, shared because done means done: if one person resolves a thread another should not still see it open. Archiving is audited, so *who marked this done* is answerable from the trail rather than from an ownership column.

## Replies

A reply goes out through `@pithy-sh/email`'s durable send path, so it carries your domain and your DKIM — and critically, so it sets `In-Reply-To` and `References` correctly. Only the Worker holds the thread's chain; implemented dashboard-side, threading breaks in the customer's mail client and every conversation fragments into one message per answer.

The dashboard POSTs a body. That is the entire contract.

### Answering without mail

**Turning on Email Routing takes over the zone's MX.** A project already running mail on that domain cannot receive support replies without consequences everywhere else on it — so for an established zone, in-app submissions with no inbound address are not the cheap path, they are the only one that disturbs nothing else. Those threads still have to be answerable.

An `app` thread has a second destination that already exists: the submitter reads their own conversation through `GET /support/feedback/:id`, outbound messages included. So a reply to one can be **stored rather than sent** — the outbound row, the thread counters and the `support/reply_sent` audit event are written exactly as they are for mail, and only the enqueue is skipped.

```ts
support({
  reply: {
    // Answer app threads in the app, on a project whose mail works perfectly well.
    deliverInApp: true,
  },
});
```

It is **a choice, not only a fallback**. A behavior conditioned on mail being *impossible* is unreachable by an adopter who can mail and would rather not — and for a submitter who is a signed-in user sitting on the screen they wrote from, the answer is better placed there anyway. With the setting off, in-app delivery still happens automatically when there is no address to reply from and no email capability to send with, because storing the answer beats refusing it.

An `email` thread never takes this path. Its sender has no read-back — there is no session, only an address — so a stored answer there is one nobody would ever see, and a missing reply address on a mail thread stays a misconfiguration to fail on. `reply.enabled: false` still refuses on both.

The reply response says which happened, and the two cannot be confused:

```json
{ "channel": "email", "messageId": "…", "jobId": "…" }
{ "channel": "app",   "messageId": "…" }
```

Two different promises about when somebody reads the answer, so they are two different shapes rather than one with an optional `jobId`. **Nobody is notified of a stored reply.** Telling a signed-in submitter is the application's call — what is a preference and what is a notice is the adopter's judgment, and a capability that grew push here would make that decision for everybody.

Alongside it, a **canned-reply catalog**: starting points a human picks, edits, and sends. Six ship, keyed to the default categories, and you add your own with `defineSupportReplies`. They are body text, not email templates — the words are yours and change on a Tuesday, while a Handlebars template changes on a release. Nothing is ever sent automatically. The machine's job is a better blank page, not the letter.

## The guard

A public support address is a public write endpoint into your D1. The guard is what stops a mail flood from being a storage bill, and its three checks are ordered by what they cost: size from the declared length before a byte is parsed, then per-sender rate — which catches the overwhelmingly common case of one broken auto-responder in a loop with your inbox — then the global rate, which is the only one that helps under a distributed flood where no single address trips the per-sender limit.

Rates are counted from the messages table itself, over an index that has to exist anyway, rather than from a counter row that would be a second write per message and a second thing to reconcile. Only inbound messages count: a burst of your own replies must never lock you out of your own inbox.

A refused message is the one inbound event that is audited, and the exception proves the rule — an accepted message leaves a row, so auditing it would duplicate a better record, whereas a refused one leaves nothing anywhere. Without that event a flood is invisible in exactly the situation where you most need to see it.

`archiveSpam` (on by default) archives a thread the moment the classifier calls it spam, so it never reaches the open inbox. **Archived, never deleted** — the classifier is wrong sometimes, and mail that was silently destroyed is not recoverable from being wrong.

## Search

Keyword search, deliberately. People search a support inbox for a word they remember — an order number, an error string, a surname — not for a concept. `@pithy-sh/vector` is there if you want meaning-matching; it is the nicer demo and the wrong default, because it cannot find `ORD-40912`.

The default is an unindexed `LIKE` scan, which is completely adequate for an inbox measured in thousands of messages.

**`search: { fts: true }` builds an FTS5 index, and there is a real cost to know before flipping it.** `wrangler d1 export` refuses to dump **any** database containing an FTS5 virtual table — `D1 Export error: cannot export databases with Virtual Tables (fts5)` — and the check runs server-side across the whole database before `--table` filtering, so it takes your entire app database's export with it, not just these tables. It does not skip the table; the export fails outright. A failed attempt has also been reported to leave the database inaccessible until it clears ([workers-sdk#6305](https://github.com/cloudflare/workers-sdk/issues/6305), [#9519](https://github.com/cloudflare/workers-sdk/issues/9519), both open).

If you do not use `wrangler d1 export`, none of that reaches you and FTS5 is the better search. Turn it on.

**Toggling it is safe in both directions.** The index is not a migration — it holds nothing that is not derived from `pithy_support_messages` — so `pithy support provision` creates or drops it to match your config, idempotently, and **backfills it from your existing messages when it creates it**. That backfill is not optional: an index created over mail that already exists starts empty, and because the table then exists the `LIKE` fallback stops firing, so search would answer "no matches" for a term plainly in the body. Flip the flag, re-provision, done. Nothing to roll back and nothing in the migration ledger to disagree with.

Until you re-provision, the two can disagree, and the code copes: with the flag on and the table absent, search falls back to the `LIKE` scan and logs what to run. A missing index is a slower search, never a failed request.

## Attachments

Stored in your own R2, served as short-lived signed URLs, **never proxied** — a dashboard fetches from R2 directly, because proxying would put a surface in the path between you and your customers' files.

Keys are server-derived and opaque, so a client can never name an object or guess the one beside it. Bytes are stored as `application/octet-stream` whatever the sender declared, because R2 echoes the stored type back on a presigned GET and a browser will render `text/html` — honoring a declared type would make every attachment a stored-XSS delivery mechanism with a signed URL as the exploit.

## The sender is a claim, and stays one

`From:` is not authenticated. Anyone can mail your inbox saying `From: your-best-customer@gmail.com`, and for every domain publishing DMARC `p=none` — most of them — it gets delivered rather than rejected.

That matters here because this capability *matches that address to a real account*. Rendering an attacker's thread decorated with a real customer's billing record is the opening move of support-driven account takeover, and the `account_access` and `privacy_request` categories route exactly those messages to a human primed to help.

**And under Cloudflare Email Routing there is no verdict a Worker can trust.** Cloudflare evaluates DMARC — its `reply()` API requires a valid result — but does not reliably hand it to your Worker: `Authentication-Results`, `Received`, and `DKIM-Signature` are all [reported missing](https://github.com/cloudflare/workerd/issues/6740) from the delivered message. Once the MTA's own header is absent, a header the *sender* wrote is indistinguishable from one an MTA wrote. An `authserv-id` does not help — it is a public hostname, not a credential, and an attacker can copy it into a header they write.

So the design does not pretend otherwise:

- **The match still happens.** A sender resolves to an account, because that is the useful part and every mail client does it.
- **The claim never does.** `sender.authenticated` is `false` unless you have explicitly said your pipeline produces a trustworthy verdict, and a dashboard should render an unverified match as exactly that — matched, not confirmed.
- **The billing history is withheld until it is proved.** Purchases, entitlements, and the account's own `emailVerified` are omitted on an unverified match. A name is a guess an operator can check; an itemized purchase history is what somebody issues a refund on.

Set `guard.trustAuthenticationResults: true` (with `guard.authservId`) only if your receiving MTA both **stamps** the header and **strips** any inbound copy of it. Verifying DKIM inside the Worker — the only signal actually present in the bytes Cloudflare hands you — is the real answer and is not implemented here yet.

## Untrusted input, everywhere

This capability's entire input is content an attacker chooses, and a dashboard renders it. The places that matters:

- **HTML is sanitized through `HTMLRewriter`** — the runtime's real parser — with an allowlist on both tags and attributes. A regex sanitizer is a list of the tricks its author thought of.
- **Remote images are stripped.** An `<img src="https://…">` in a support message is a read receipt telling the sender when somebody opened their mail and from which IP. The `alt` survives.
- **Filenames and MIME types are recorded as declared and never honored.** Path separators, control characters, and right-to-left overrides are stripped on the way in.
- **Display names and addresses are normalized once**, on ingest, so every join is plain equality.
- **Domain alignment is a public-suffix lookup, not label arithmetic.** DMARC relaxed alignment is defined in terms of the Organizational Domain, so `tldts` computes it — with the PSL's private section on, so two sites sharing a host like `github.io` do not align with each other.
- The classification prompt delimits the body, but the real defense against prompt injection is structural: the output is validated against a closed enum, so the worst achievable outcome is a wrong label on one thread — and a wrong label is recomputed.
- Nothing a sender wrote ever reaches an error message or an audit event's metadata.

## Routes

Every route is `control-plane` and **default-denied**. There is no public and no bearer surface: a customer interacts with this by sending email, so there is nothing for an end user to call. With the control-plane seam uncomposed, every one of these answers 403.

| Method | Path | Scope |
|---|---|---|
| GET | `/support/threads` | `support:threads:read` |
| GET | `/support/threads/:id` | `support:threads:read` |
| GET | `/support/replies` | `support:threads:read` |
| POST | `/support/threads/:id/archive` | `support:threads:archive` |
| POST | `/support/threads/:id/reply` | `support:threads:reply` |
| POST | `/support/threads/:id/reclassify` | `support:threads:reclassify` |
| POST | `/support/threads/:id/flags` | `support:threads:flag` |

Three more answer to the adopter's own signed-in user, and to no scope at all:

| Method | Path | Strategy |
|---|---|---|
| POST | `/support/feedback` | `bearer` / `session` (+ same-origin) |
| GET | `/support/feedback` | `bearer` / `session` |
| GET | `/support/feedback/:id` | `bearer` / `session` |

**The two surfaces never stack.** A management client holds no session and owns no account row — core leaves `c.var.auth` null for one deliberately — so a control-plane credential can never satisfy `requireAuth()`, and a user's session confers no scope. Stacking the gates would deny every legitimate call on both, permanently. `requireSameOrigin()` sits on the submission and on neither read: a cookie-mode POST here writes into a support inbox under a real customer's name, which is the one place an operator treats attribution as proven. Bearer callers are CSRF-exempt, and that exemption belongs to the gate `@pithy-sh/auth` publishes.

`GET /control-plane/manifest` advertises the management routes only. A manifest entry for `/support/feedback` would offer a management client a path its credential can never open.

Five scopes, not one admin flag. Reading an inbox exposes every customer's private correspondence; replying sends mail to a real person under your domain and DKIM. Those are not the same permission, and a compromised reply credential is a phishing platform with a verified sending domain attached.

Listing is cursor-paginated on `(receivedAt, id)`, never offset — mail arrives at the front of the order the list is sorted by, so offset silently shifts rows under somebody's scroll.

## Errors

| Code | Status | When |
|---|---|---|
| `support/not_found` | 404 | No such thread, message, or attachment. |
| `support/invalid_category` | 400 | A category or canned reply failed validation at author time. |
| `support/unparseable_message` | 400 | Inbound mail was not readable as email, or carried no sender. |
| `support/rejected` | 429 | The guard refused a message on size or rate, or an account is over its submission bound. |
| `validation/invalid_input` | 400 | A submission broke a configured bound — body length, attachment size, count, or type. |
| `support/classification_failed` | 500 | The AI step could not run. A bad *answer* is not this — it becomes `uncategorized`. |
| `support/reply_failed` | 502 | Replies are off, or a reply that needed mail had nothing to send it with. An `app` thread is answered in the app instead of raising this. |

## Testing

```
bun run --filter @pithy-sh/support test
```

Node tests cover parsing, threading, sanitization policy, the guard, and classification against injected fakes. Workers tests run against real D1 and R2 through Miniflare — migrations and their rollbacks, ingest and idempotency, cursor pagination, and both search backends.

## License

MIT.
