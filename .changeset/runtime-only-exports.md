---
"@pithy-sh/leaderboard": patch
"@pithy-sh/payments": patch
"@pithy-sh/testers": patch
"@pithy-sh/cli": patch
---

A module that imports `cloudflare:workers` exports nothing a non-runtime module could want.

That has been the rule since #172 and #180 — the same defect twice, where a Node-side caller imported a constant out of a Durable Object module and got the whole Workers runtime behind it. The symptom is `Could not load pithy.config.ts`, which names the config rather than the import, and #172 cost real time for exactly that reason.

Three modules still offered one. `REFRESH_BATCH_CHUNKS` moves from `leaderboard`'s `rank/worker.entry.ts` to `rank/materialize.ts`, beside the chunk size it is counted in. `auditLogEmit` and `logReconcileReport` move from `payments`' `workflows/worker.ts` to `workflows/report.ts`, and `logPassComplete` and `logCohortFailure` from `testers`' `workflows/worker.ts` to its own `workflows/report.ts`. Each runtime module imports from its pure sibling; nothing else changes for a caller, and none of the five was live.

`configEntrypoints.test.ts` now states the invariant rather than listing the files. It reads every runtime module in the tree and requires each value export to be a class extending a `cloudflare:workers` base, or the worker's default handler — a type export is free, since it erases. Enumerating known instances is what produced the second and third of every defect class here, so this asks the question about the module.

The two `report.ts` modules' tests are node tests now. They were workers-project tests only because the functions sat beside a `WorkflowEntrypoint`; that they load in a plain Node process at all is the proof.
