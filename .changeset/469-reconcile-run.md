---
"@pithy-sh/payments": patch
"@pithy-sh/core": patch
---

A reconciliation pass can be started through the control plane, instead of waiting for the cron.

Reconciliation is the repair path for a dropped `subscription.updated` webhook: until a pass runs, a
customer who paid holds no entitlement and a customer who canceled still does. There was a read of the
run log and no way to start one, so the answer to *"my subscription isn't showing up"* was
`pithy payments reconcile` — a laptop, a checkout and a Cloudflare API token — or nothing until 04:00.

`POST {base}/admin/reconcile-runs` starts a pass and answers `{ started, runId }`.

**`payments:reconcile:run` is its own scope, and that is the sharpest split in the list.** Reading the
log says whether the nightly repair has been firing; starting a pass calls the store, walks the catalog
and *writes entitlements* — granting what a webhook never granted, revoking what a missed cancellation
left standing. A health monitor holding `:read` to alarm on a stopped cron must not be able to move
somebody's access, and `scopeCovers` matches exactly, so it cannot.

**A missing Workflow binding refuses rather than degrading.** `triggerWorkflow` skips an `optional` job
with a warning, which is right for a background dispatch on a request that works without it. It is wrong
here: somebody pressed a button to make a pass happen, and `202 started` over a pass that will never run
is the one answer worse than a refusal. The binding is resolved directly, and its absence is a 501 —
`payments/reconcile_not_provisioned` — naming the deploy that fixes it. Not a 404, which sends a reader
looking for a typo, and not a 500, which sends them to logs for something that did not fail.

Idempotent, like the pass itself: a second press while one is in flight starts nothing and says
`started: false`, which is true rather than a 409 that reads as a fault.

Fixes #469
