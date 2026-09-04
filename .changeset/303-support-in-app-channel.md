---
"@pithy-sh/support": minor
---

Let a signed-in user reach support without opening their mail client.

`@pithy-sh/support` could only be reached by email. A product with a logged-in user, a session, and a support console had to ask that user to go and write one — and `inbound/` is entirely mail, down to the SMTP envelope.

`POST /support/feedback` opens a thread from inside the app, behind `requireAuth()` and nothing weaker. Same table, same classifier, same federated taxonomy, same console: a channel, not a second capability, because a second inbox is a support person with two consoles and the whole conversation in neither.

**This is the channel where the mail path's hardest problem does not exist.** `inbound/authenticity.ts` spends two hundred lines earning a customer link from a `From:` header anybody can write, and warns at length about what happens when it is wrong. An in-app submission has no `From:` to spoof — `requireAuth()` proved the session before the handler ran. So `accountLinkSource` records *how* a thread came to name an account, `session` or `email_address`, and a console can tell a link that **is** the identity from one that was matched against a claim. They are not the same evidence, and the same refund follows from both.

`channel` (`email` or `app`) rides on threads and messages and the inbox filters on it — per message too, because a reply to an app thread is `email`: that is where the person will read it. The submission is minted a `Message-ID`, so when they answer that reply the conversation stays one conversation instead of forking.

The app supplies screen, build, platform, environment, and locale, and that set is closed: an undeclared key is refused rather than stored, so this cannot become a telemetry pipe pointed at a support inbox. Attachment bounds are stated for a direct upload rather than inherited — 5 MB, three files, and a content-type allowlist, where the mail path has no type restriction at all and would have shipped a 10 MB any-type upload endpoint by default. Bytes arrive base64, either alphabet, and the size bound is measured on the decoded length; the declared filename is sanitized by the same rule the mail path uses, so a right-to-left override cannot make an executable render as a screenshot in a console. Ten submissions per account per hour, counted over the same sliding window the mail guard uses and **only against its own channel**, so neither surface can starve the other.

`GET /support/feedback` and `/support/feedback/:id` hand a submitter their own conversations and nothing else — never the classification, never an operator's flags, never another account's. Somebody else's thread answers 404 rather than 403, because a 403 confirms the id names a real conversation. The projection is built from scratch rather than by nulling fields on the operator's view: one that starts from the operator's shape leaks the next column somebody adds.

`submission: { enabled: false }` does not mount the routes at all.
