---
"@pithy-sh/cloudflare": patch
"@pithy-sh/email": patch
---

Inbound Email Routing is verified against a live Cloudflare zone, and what arrives is now written down rather than assumed.

`@pithy-sh/email` has provisioned an inbound routing rule since #27, and nothing had ever pointed it at a real zone. The rule shape, the idempotency, the error paths, and — the part three other issues were waiting on — **what Cloudflare actually hands a Worker's `email()` handler** were all beliefs. They are assertions now, in `packages/email/src/bounce/inboundRouting.integration.test.ts`, gated on the `email-routing` and `email-sending` fixtures.

**There is no inbox, and the suite is written around that rather than pretending otherwise.** The fixture zone's only standing rule is a catch-all that drops, and the account has zero verified destination addresses, so nothing sent there can be read from a mailbox. The Worker is the destination, so the Worker is the witness: the suite deploys a throwaway recorder, routes a real message to it, and reads back what the handler was given.

What the live run settles:

- The stored rule matches what `ensureWorkerRoute` posts — `matchers: [{ type: "literal", field: "to", … }]`, `actions: [{ type: "worker", value: [name] }]` — read back off the zone, never off the request.
- A second provision reuses the rule. A remove is idempotent. A rule pointing at a Worker that does not exist is refused and leaves nothing behind.
- **Two rules on one zone do deliver to two different Workers.** The README's "one Worker per domain" was the narrower claim, not the constraint.
- **`message.headers` carries the authentication headers**, `Authentication-Results` and `DKIM-Signature` among them. Cloudflare stamps its own verdict with the authserv-id `mx.cloudflare.net`, above everything the sender wrote, and strips nothing below it. So a consumer reads the topmost instance and treats the rest as attacker-controlled.

The trust boundary gets the weight it deserves, in `handler.workers.test.ts` against real D1: an empty message, bytes that are not a message, a truncated header block, a forged `Authentication-Results`, SQL in a recipient, an address broken across two lines, an appended `Final-Recipient`, a megabyte of body, and five thousand `Message-ID` headers. The handler never throws for any of them, which is the invariant that matters — a throw out of `email()` is a delivery failure Cloudflare retries, and the same message fails the same way, so a crash is a free amplifier.

One finding is recorded rather than fixed, because fixing it is #93: nothing authenticates the sender of an inbound message, so a DSN invented by anyone who can reach the routed address suppresses whatever recipient it names. The live run settles that issue's precondition — the DKIM signature survives delivery, so verifying it inside the Worker is possible.

The debris sweep gains its first zone-scoped kind. An abandoned routing rule is the one piece of test debris in this repository that changes what happens to somebody's mail, so it is reaped — and only on a zone the fixture named, never on one guessed from an account.
