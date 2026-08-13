---
"@pithy-sh/testers": patch
"@pithy-sh/cli": patch
---

A testers pass that crosses midnight files every cohort under one day.

`TestersDailyWorkflow.run` read its clock in the driver body, and that clock decides the day key every snapshot is written under. A Workflow does not resume inside the step it died in — it re-executes the body from the top and serves every completed step from the journal — so a pass that began at 23:58 and resumed at 00:05 filed its remaining cohorts under the next day. One run, two rows of a series, and nothing later corrects it: the darkness histogram cannot be recomputed after the fact.

The instant is journalled in a `pass-instant` step now, so a straddling pass belongs to the day it began — the day it sampled activity on.

**The nudge clock is deliberately left alone, and now has a module and a test saying so.** `enqueueEmail` writes the instant it is given as an email job's `createdAt`, and the email scheduler re-drives any `pending` job older than `graceMs` on the assumption its dispatch died. A nudge stamped with an instant the pass read an hour ago is born already past that cutoff, so the next tick claims it and starts a second send Workflow against the one the enqueue just dispatched — a double-send. That seam moved to `nudge/enqueueSeam.ts`, takes its clock as a thunk it reads per nudge, and is held there by a test that drives a real scheduler tick over both stampings. Day key stable, enqueue fresh.

The Workflow's body moved to `workflows/pass.ts` as `runDurableDailyPass`, taking a structural step runner the way `reconcilePayments` and `runAtRestKeyRotation` take theirs. `worker.ts` imports `cloudflare:workers`, so nothing inside it can be exercised without deploying it — and every property worth proving about this body is a property of a resume.
