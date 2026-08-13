---
"@pithy-sh/core": patch
"@pithy-sh/payments": patch
---

Derive the entitlement census's own claim, and walk an array by everything it holds.

Three gates that could not fail for the reason they exist.

The entitlements census checked itself against the code in one direction. A writer's account was re-derived from the declaration's text on every run, so removing a guard failed — but `writes: false` was a bare claim nothing ever looked at, and an `insertInto(PAYMENTS_ENTITLEMENTS_TABLE)` added inside `keysToDerive` left the suite at eleven passed. Every mention is now classified from its own text and the census is compared against that, in both directions. The form list is positive: a mention matching none of them is not read as harmless, it is a failure quoting the line, so raw SQL and a Kysely verb nobody listed both land there rather than being absolved by omission.

`unpublishedIn` stated that a container is one whose whole contents `Object.entries` returns, and then ran a different rule on arrays. `value.map` walks positions, and a position is not everything a plain array holds: `rows.cursor = "…"` sits on a prototype the walk accepts and was never visited — so a projection gate saw nothing, and `leavesIn`/`keysIn` built a permitted set with the field missing. `Object.entries` descends both branches now. An index key is still a position, reported as `[0]` and never a key a caller must permit.

And the reconciliation read's anti-vacuity guard asserted its permitted facts with `toContain` over the serialised row, which a substring satisfies. It checks each one is present as a leaf. The catalog read beside it had the same slack — `"coins"` sits inside `"coins_100"` — and is fixed with it.
