---
"@pithy-sh/cli": minor
---

A Worker that could not be checked stops erasing every other Worker's health.

`buildProjectHealth` built one reconcile plan per Worker in a bare loop. A plan reads that Worker's own `pithy.config.ts` and `wrangler.jsonc` and, through the ledger, its databases — so any of it can fail for reasons belonging to one Worker. The throw propagated, and `pithy doctor` lost every *other* Worker's config, bindings, migrations, entitlement and prerequisite lines. That is the command whose whole job is saying which part of a project is broken.

**The asymmetry is the point.** This function's manifest half was degraded per package under #184 and its per-Worker half never was. The fix was agreed in this file; it had been applied to one loop and not the other.

`WorkerHealth` is a two-state value now. The five checks live behind `checked`, and `unavailable` carries nothing but the Worker's name — no `ok`, no empty drift lists, no `0 pending` to mistake for a clean bill. The state rides on the value, so an unchecked Worker cannot be rendered as a checked one.

It still fails the exit, on the standard #184 set: a check that did not run established nothing, and calling a project healthy around a hole is the under-report both exist to prevent. That is also what the behavior already was — the throw reached `pithy doctor`'s catch and drove a non-zero exit — so the CI gate does not weaken, it only stops taking the rest of the report with it.

The manifest scan is deliberately not guarded here. It is read once at the project and every plan is built from it, so it is the loop's input rather than one of its contributors.

**Nothing from the throw travels.** The guard takes no binding. The Worker's name is the actionable fact, and `pithy doctor` already prints it.
