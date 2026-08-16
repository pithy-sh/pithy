---
"@pithy-sh/email": minor
---

A job row can say what its message was *about*, so one template can carry more than one message.

`pithy_email_jobs` gains `correlation`: a nullable text column, set at enqueue through `EnqueueInput.correlation`, matched by `sentSince`, indexed as `(correlation, created_at)`. Opaque — this capability never parses it, renders it, or puts it on a header or a link.

`#354` shipped `sentSince(db, { to, template, since })` and could not finish its only intended consumer. Six account notices — a plan ending, ended, standing after all, refunded, revoked, paused — ride one `operationalNotice` template to the same addresses. `(to, template)` sees one undifferentiated pile.

**The cost of that was not a duplicate.** The caller uses the answer *positively*: the correction letter, *your plan is not ending after all*, goes out only when the letter it corrects already did. So an under-report sends nothing at all. It withholds the correction from somebody holding a letter that has stopped being true, and nothing raises. Silence, to the one person owed the message.

`SentFilter` is now a union: `(to, template)`, or a `correlation`, or both. A union rather than three optional fields because of the shape it forbids — a filter naming neither axis is an unbounded scan of every email a project ever queued, asked on the path that decides whether to send. It cannot be constructed.

**Not `campaignId`.** That column is documented marketing-only, and repurposing it would not merely be a misleading name: it is copied onto every `pithy_email_events` row, grouped by `campaignStats`, and signed into the tracking token that travels in the URLs of delivered mail. A transactional discriminator put there lands in campaign analytics and inside a string a recipient's mail client fetches.

The column is folded into `email_0001_init` rather than added as a `0002`, per CONTRIBUTING.md §Migrations and the gate that enforces it. The condition was checked, not assumed: `@pithy-sh/email` is `0.0.0` and 404s on npm, and the only adopter's pinned Cloudflare account holds no D1 database at all. Nothing anywhere has a row to walk.
