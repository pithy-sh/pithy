---
"@pithy-sh/email": minor
---

Suppression is automatic. Compose `email(...)` and a hard-bounced address is never queued for a send — no binding name in your config, no option threaded through your routes, no constant of your own.

`enqueue` already spared consumers `DB` and `EMAIL_SENDER`; it did not spare them the suppression list. So a consumer that wanted to know whether a message would actually reach somebody had to name `EMAIL_SUPPRESSIONS` itself, build the database, and call `blockingSuppression` — the one binding the capability offered no accessor for was the one binding a consumer could not avoid naming. `pithy-sh/dashboard` carried a `suppressionsBinding` option and a defaulted constant for exactly that, and can now delete both.

`EmailEnqueueEnv` carries `EMAIL_SUPPRESSIONS`, which the capability has always declared as a required binding, and `enqueue` reads it off the env you already forward. A blocked recipient's job row is born `suppressed` with a `suppressed` event beside it, and `EnqueueResult` carries `suppressionReason` — so a caller learns at the moment it asked, rather than discovering three ordinary skips in a send log next week. `runSend` remains the authority, because whether an address is blocked is a question about the instant of sending and a scheduled job is enqueued days before that; this is the caller being told, not a second gate.

**It is asked of the template's own kind, never a restated `"transactional"`.** That is what keeps an unsubscribe from a newsletter from withholding an invitation while a hard bounce withholds both, and an automatic check that treated every send alike would have started dropping those silently. `send/aSuppressionNeedsNoDeclaration.workers.test.ts` drives all eight reason-by-kind cells end to end against a frozen table — written out rather than derived from the function it polices — and asserts the table names every reason and kind the schemas declare, so a new one fails the build rather than passing untested.

**And the list is yours.** `EmailCapability.suppressions(env)` hands back the Kysely handle, still naming no binding, and `blockingSuppression`, `suppress`, `unsuppress`, `listSuppressions` and `suppressionBlocks` are exported from the package root. An operator lifting a block on an address a customer has fixed, or a support screen explaining why a letter did not go, is ordinary code against an ordinary table. Nothing gates it — the only thing the capability keeps for itself is the wiring.
