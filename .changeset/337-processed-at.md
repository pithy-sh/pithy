---
"@pithy-sh/payments": patch
---

Separate "we finished this delivery" from "we gave up on it", so a purchase that failed to project can be projected.

`pithy_payments_webhook_events.processedAt` had one documented meaning and three writers, and two of them meant something else. The webhook guard short-circuits on that column, so both wrong meanings silently stopped a purchase from ever being projected — on every rail, not only the one it was found on.

**A delivery that arrived and failed is no longer marked processed.** `completeWebhook` wrote `processedAt` beside its error, so the guard answered the provider's retry `duplicate`, a manual replay reuses the same event id and was answered `duplicate` too, and the Paddle sweep read freshness off the same column and skipped exactly those rows. Nothing in the package repaired a failed delivery. It now leaves `processedAt` null beside the reason, and the next delivery reprocesses. Apple, Google, Stripe, Lemon Squeezy and Paddle each have an end-to-end case proving it.

**A quarantined sweep event no longer blocks its own redelivery.** The sweep gives up after three attempts so one unprojectable event cannot hold the stream up; it stamped `processedAt` to do that, which also told the guard the event was finished. A quarantine that bounds a stall had become terminal — fixing the cause repaired nothing. There is now an `abandonedAt` column: invisible to the sweep, so the attempt count does not restart, and fully visible to a webhook delivery, which is what repairs it.

**The state is derived, not stored.** `webhookEventState` classifies a row as `pending`, `failed`, `abandoned` or `finished`, and the two readers ask different questions of it by name — `isWebhookEventFinished` for the guard's short-circuit, `isWebhookEventOutstanding` for a repair pass. A stored status enum would have made the writers exhaustive and left every reader free to spell out its own predicate, which is where the defect actually lived. Two timestamps beside it answer *when*, which is what this table is read for, and cannot contradict each other the way an enum can contradict the timestamp beside it.

`PaddleSweepReport.quarantined` is now the abandoned event ids rather than a count: an operator replays an id, not a total.
