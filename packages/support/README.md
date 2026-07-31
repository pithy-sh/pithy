# @pithy-sh/support

An inbound support inbox that lands mail in your own D1, classifies it on your own Workers AI binding, and links each sender to the account and purchases your app already knows about.

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

From there: the guard bounds it, `postal-mime` parses it (multipart and attachments included), the HTML is sanitised through the runtime's own parser, the raw MIME goes to R2 unchanged, and the row lands in D1. Only then is classification dispatched — as a Workflow, because an inbound handler has a tight CPU budget and a model call does not fit in it. A model that is slow or briefly down must never take the persistence of somebody's support request with it.

Threading is on `In-Reply-To` and `References`, never on the subject. Subject matching is what puts two unrelated people who both wrote "Refund" in one thread, and what splits a real conversation the moment a client localises `Re:` to `Aw:`.

## Classification

Three axes from one call — category, priority, sentiment — because together they make a sortable inbox rather than a labelled one.

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

Keys are server-derived and opaque, so a client can never name an object or guess the one beside it. Bytes are stored as `application/octet-stream` whatever the sender declared, because R2 echoes the stored type back on a presigned GET and a browser will render `text/html` — honouring a declared type would make every attachment a stored-XSS delivery mechanism with a signed URL as the exploit.

## The sender is a claim, and stays one

`From:` is not authenticated. Anyone can mail your inbox saying `From: your-best-customer@gmail.com`, and for every domain publishing DMARC `p=none` — most of them — it gets delivered rather than rejected.

That matters here because this capability *matches that address to a real account*. Rendering an attacker's thread decorated with a real customer's billing record is the opening move of support-driven account takeover, and the `account_access` and `privacy_request` categories route exactly those messages to a human primed to help.

**And under Cloudflare Email Routing there is no verdict a Worker can trust.** Cloudflare evaluates DMARC — its `reply()` API requires a valid result — but does not reliably hand it to your Worker: `Authentication-Results`, `Received`, and `DKIM-Signature` are all [reported missing](https://github.com/cloudflare/workerd/issues/6740) from the delivered message. Once the MTA's own header is absent, a header the *sender* wrote is indistinguishable from one an MTA wrote. An `authserv-id` does not help — it is a public hostname, not a credential, and an attacker can copy it into a header they write.

So the design does not pretend otherwise:

- **The match still happens.** A sender resolves to an account, because that is the useful part and every mail client does it.
- **The claim never does.** `sender.authenticated` is `false` unless you have explicitly said your pipeline produces a trustworthy verdict, and a dashboard should render an unverified match as exactly that — matched, not confirmed.
- **The billing history is withheld until it is proved.** Purchases, entitlements, and the account's own `emailVerified` are omitted on an unverified match. A name is a guess an operator can check; an itemised purchase history is what somebody issues a refund on.

Set `guard.trustAuthenticationResults: true` (with `guard.authservId`) only if your receiving MTA both **stamps** the header and **strips** any inbound copy of it. Verifying DKIM inside the Worker — the only signal actually present in the bytes Cloudflare hands you — is the real answer and is not implemented here yet.

## Untrusted input, everywhere

This capability's entire input is content an attacker chooses, and a dashboard renders it. The places that matters:

- **HTML is sanitised through `HTMLRewriter`** — the runtime's real parser — with an allowlist on both tags and attributes. A regex sanitiser is a list of the tricks its author thought of.
- **Remote images are stripped.** An `<img src="https://…">` in a support message is a read receipt telling the sender when somebody opened their mail and from which IP. The `alt` survives.
- **Filenames and MIME types are recorded as declared and never honoured.** Path separators, control characters, and right-to-left overrides are stripped on the way in.
- **Display names and addresses are normalised once**, on ingest, so every join is plain equality.
- **Domain alignment is a public-suffix lookup, not label arithmetic.** DMARC relaxed alignment is defined in terms of the Organizational Domain, so `tldts` computes it — with the PSL's private section on, so two sites sharing a host like `github.io` do not align with each other.
- The classification prompt delimits the body, but the real defence against prompt injection is structural: the output is validated against a closed enum, so the worst achievable outcome is a wrong label on one thread — and a wrong label is recomputed.
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

Five scopes, not one admin flag. Reading an inbox exposes every customer's private correspondence; replying sends mail to a real person under your domain and DKIM. Those are not the same permission, and a compromised reply credential is a phishing platform with a verified sending domain attached.

Listing is cursor-paginated on `(receivedAt, id)`, never offset — mail arrives at the front of the order the list is sorted by, so offset silently shifts rows under somebody's scroll.

## Errors

| Code | Status | When |
|---|---|---|
| `support/not_found` | 404 | No such thread, message, or attachment. |
| `support/invalid_category` | 400 | A category or canned reply failed validation at author time. |
| `support/unparseable_message` | 400 | Inbound mail was not readable as email, or carried no sender. |
| `support/rejected` | 429 | The guard refused a message on size or rate. |
| `support/classification_failed` | 500 | The AI step could not run. A bad *answer* is not this — it becomes `uncategorized`. |
| `support/reply_failed` | 502 | `@pithy-sh/email` is absent, or refused the job. |

## Testing

```
bun run --filter @pithy-sh/support test
```

Node tests cover parsing, threading, sanitisation policy, the guard, and classification against injected fakes. Workers tests run against real D1 and R2 through Miniflare — migrations and their rollbacks, ingest and idempotency, cursor pagination, and both search backends.

## License

MIT.
