---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

A successful rotation records a rotation, whichever path ran it.

`pithy secrets rotate` dispatched an ordinary `update`, and an update is not an event the write core can name — so nothing advanced `lastRotatedAt`, the secret reported **overdue** permanently, and rotating again did not help because the next rotation was also an update. The same act performed from a control-plane client recorded correctly. Two paths to one act, disagreeing about whether the act happened, and an operator rotating on the command line during an incident told by the product that they did not.

`rotateSecretValue` now takes a `RotationLedger` as a **required** argument and brackets the run with it: refuse, open the row, produce once, store with retries, close the row. Required because an optional one is the one a caller forgets, which is exactly how this happened. The row opens before the roll, so a rotator that never returns still leaves an `in_progress` trace; it opens only after every refusal, so a rotation that never started writes no history.

Two implementations of one seam, because there are two kinds of caller and only one holds the database. `trackerRotationLedger` writes the table directly, for anything running inside an environment. `dispatchedRotationLedger` reaches the same table through the manager write-Workflow, which is how the CLI writes anything — two new dispatch modes, `rotation-open` and `rotation-close`, answered by `runWriteWorkflow`. Both compose the closing verdict the same way, per environment: a fan-out that reached staging and stranded prod closes `success` in one ledger and `failed` in the other.

A first write and a rotation stay different events. `recordBaseline` keeps writing `trigger: baseline` on the create branch, a rotation writes `manual` with an actor, and `pithy secrets update` records neither — inferring a rotation from a write would let a typo fix advance a freshness clock nobody rotated.

Bookkeeping never blocks the act: a ledger that cannot be reached costs the row, not the rotation. A close carries a reason **code**, never free text, so the failure sentence is composed inside the Worker and no shape crossing the wire could carry a value.
