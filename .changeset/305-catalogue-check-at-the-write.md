---
"@pithy-sh/payments": patch
---

The catalogue check now guards the write, not the route.

`POST {base}/entitlements/grant` refused a key this project does not define. `grantEntitlement` — the function that writes the row, exported from the package's public surface — refused nothing. So an adopter's own handler, a later route in this package, or the reconciliation workflow could write a comp for `pr`, the exact typo the check exists to catch, and nothing would say no.

**This is a shape, not an incident.** Four defect classes in this kit have each had three or more producers — the unresolvable dependency range, the `.dev.vars` file mode, the symlink escape, publishing ignored files — every one because a rule lived at a call site instead of at the thing being called. This is that shape, closed on the first producer.

**The split.** `writeEntitlement` asks nothing and is not exported. `grantEntitlement(d1, config, input, options?)` takes a `PaymentsConfig` it cannot be called without, consults `grantableEntitlements`, and throws `payments/entitlement_not_in_catalog` before any row exists. The handler no longer decides; it catches the refusal and records it, which is the only job an edge should have here.

**The escape hatch travels.** The check reads `grantableEntitlements`, so `manualEntitlements` — the keys an adopter comps but does not sell — still grants. A project that declares nothing and sells nothing refuses every grant, which is correct: there is no vocabulary to grant in.

**Revoke stays unchecked, and its signature says so.** `revokeEntitlement` takes no config and must never grow one, or dropping a product from the catalogue would be irreversible for every account still holding its key.

**The gate.** Two invariants, both derived from the tree rather than from a roster of today's callers: every module that writes `pithy_payments_entitlements` either consults the grantable set or writes the hold off, and the manual module exports nothing that sets the hold without a catalogue. A new producer fails the build without anybody remembering this change.

Callers of `grantEntitlement` pass the config as the second argument. `revokeEntitlement` is unchanged.
