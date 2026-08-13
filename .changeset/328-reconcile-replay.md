---
"@pithy-sh/payments": patch
---

A reconciliation run keeps one id across a replay, and three gates around it are made able to fail.

`reconcilePayments` minted its run id in the driver body, outside every step. A Cloudflare Workflow does not resume inside the step it died in — it re-executes the driver from the top and serves every completed step from the journal — so a resumed pass minted a second id. The pages before the interruption had already audited their repairs under the first one, and the run record written at the end named the second. The runs table's only join to the audit trail pointed at nothing, on exactly the replay durable execution exists to survive. The mint is its own `mint-run-id` step now, so the journal returns the id the earlier pages were repaired under. Proved by driving a run, interrupting it, and resuming it against the same journal.

The reconciliation run log's disclosure sweep ran over `PaymentsAdminReconcileRunsResponse.parse(body)`. Zod strips unknown keys, so both halves of the invariant examined a document the widening had already been removed from: an undeclared field crossed green. It reads the raw body now, and the case that plants one is in the suite. The catalog, purchase and entitlement sweeps beside it always read the raw body; this one alone did not.

Its two walkers were a private copy of `@pithy-sh/core`'s `unpublishedIn`, added to the same file the extraction had just cleaned. There is one producer again.

The entitlement-writer gate classified by literal syntax, per file, and three escapes were reproduced against it: a raw-SQL `insert into pithy_payments_entitlements`, a write through `d1SeedGroup` that no list of Kysely methods holds — `src/seeds/example.ts` really does this and was never examined — and a file whose accounted write absolved its unaccounted one. It names no verb vocabulary at all now. A site is any mention of the table, under either spelling, in code rather than a comment, located to the declaration holding it; a census says what each is, fails on a site it does not name and on an entry no site matches, and re-derives each writer's account from its own text. What it still cannot see is written down beside it.
