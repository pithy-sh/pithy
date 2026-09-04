---
"@pithy-sh/payments": patch
---

A reconcile pass now leaves a queryable record of itself.

`pithy payments reconcile` ran, repaired, and left nothing behind but a log line. *"Has reconciliation been running?"* had no answer except reading Workers Logs, and *"what did it fix last month"* had none at all — so an adopter could not tell a healthy integration from one whose cron had stopped firing, because a silent nightly job and a job that is not running look the same from outside.

That matters more here than it would elsewhere. **Reconciliation is the compensating control for a delivery mechanism that is known to fail.** When a webhook goes missing, an adopter's entitlement state silently diverges from what a customer paid: somebody paid and is not unlocked, or canceled and still is. The pass that repaired it is the proof that happened, and it was the least observable thing the capability produced.

**`pithy_payments_reconcile_runs`** — a fifth table, folded into `0001_purchases` because nothing is published yet. One row per pass: started, finished, store environment, the rail it was narrowed to (null for the scheduled every-rail pass), and the tally — pages, scanned, unchanged, drifted, superseded, skipped, failed — plus `truncated` and `dryRun`. Counts, timestamps and enums; there is no column a store's response could be written into, which is a stronger control than never selecting one.

**A pass that found nothing is stored.** That is the load-bearing half: only storing the exceptional passes makes an empty table mean either "healthy" or "the cron stopped", and telling those apart is the point.

**The audit trail is not duplicated.** Repairs stay there, once, and every `payments/purchase_reconciled` event now carries the run's id as `runId`. The run holds the tally the events cannot reconstruct — nothing in them says where one pass ended and the next began — and points at them rather than copying them.

**`GET {base}/admin/reconcile-runs`**, paged newest first, filterable by rail and environment, behind **`payments:reconcile:read`** — its own scope, granted separately, because a run names no account, no transaction and no amount. A health monitor can hold exactly this without acquiring the purchase log; `scopeCovers` matches exactly, so neither confers the other. Declared in `adminRoutes`, in the README's Routes table, and in the disclosure map beside the tables.

**Retention is ninety days**, pruned by the writer on every pass rather than by a second scheduled job — the only thing that could stop pruning is the thing that has also stopped writing.

The disclosure gate is a **positive invariant**: every key in the response is one of the fifteen written out in the test, and every leaf is a fact the run itself recorded. Not a list of forbidden strings — the field that leaks is the one nobody thought to forbid.

`ReconcileReport` gains `runId`. Callers reading the report by field are unaffected.
