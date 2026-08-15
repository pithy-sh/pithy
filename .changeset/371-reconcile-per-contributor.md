---
"@pithy-sh/cli": minor
---

A reconcile plan keeps its four other answers when one contributor throws.

`buildReconcilePlan` gathers five contributions per Worker — the capability manifests, the config source, the wrangler stanzas, the migration ledger, and the entitlement scan. Three of them had degraded per contributor since they were written. Two had not: the ledger read and the entitlement scan both threw straight out of the plan, so an unreachable D1 or a source tree that would not walk cost `pithy doctor` and `pithy upgrade` the whole report for that Worker — including every capability's binding and config drift, which was already in hand.

Both are guarded now, and neither is load-bearing: a plan is a report, and a report is what an adopter reads to find out why something is wrong.

**Each failure is a state on the value, not an empty list.** `ledger` gains `unavailable`, which carries no count for a caller to render as `0 pending`. `entitlementGap` becomes `entitlements`, a two-state value whose file list lives behind `read` — because an empty array said "no gap" and "no scan" in the same two characters, and only one of those is good news. `pithy doctor` prints the difference; a check that did not run no longer reads as a check that passed.

**Nothing from either throw travels.** Both guards take no binding. `readLedger` reaches a customer's D1 and the entitlement scan walks their source tree, so both throw with ids, queries and absolute paths in them — and this plan is what `pithy upgrade --json` prints.

`pithy upgrade --json`'s per-Worker plan replaces `entitlementGap` with `entitlements`.
