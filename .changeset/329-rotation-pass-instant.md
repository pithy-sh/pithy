---
"@pithy-sh/secrets": patch
---

An at-rest key rotation records the instant the pass began, not the instant it resumed.

`runAtRestKeyRotation` read its clock in the driver body. A Workflow does not resume inside the step it died in — it re-executes the body from the top and serves every completed step from the journal — so a rotation interrupted at midnight and resumed at six wrote `lastRotatedAt: 06:00` for a pass that started at 00:00. This is the key material every other secret is encrypted under, and a rotation history that misdates itself is one that cannot be reconciled against an audit.

The clock is journalled in a `pass-instant` step now, as epoch milliseconds so the value survives a JSON round-trip through the journal unchanged. The `options.now` seam a test injects through is untouched: the read moved inside the step, so an injected clock is still what gets read and still what gets journalled.

It was checked, not assumed, that this clock carries no liveness meaning. `lastRotatedAt` has one reader — `isRotationDue`, a cadence question asked in days by a cron that starts nothing while an instance is live — and the rotation row's own `startedAt`/`completedAt` are written inside `RotationTracker`'s steps and read only for display. Nothing re-drives this pass off a timestamp, so freezing the instant strands no running work. The sibling clock in the email worker looked equally plain and was not.
