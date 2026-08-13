---
"@pithy-sh/payments": patch
"@pithy-sh/testers": patch
"@pithy-sh/email": patch
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

No Workflow driver body reads a clock or a random source outside a step, and a gate over every shipped Workflow says so.

A Cloudflare Workflow does not resume inside the step it died in. It re-executes the driver from the top and serves every completed step from the journal, so anything the body computes answers differently on the second attempt. #328 moved payments' run id into a step for exactly that reason and left `const now = deps.now()` on the line above it — the same defect, one field over, in the fix for it. `startedAt` was therefore recomputed on resume, and a run interrupted at nine and resumed at three recorded a start six hours **after** the repairs its own id is stamped on. The runs table exists to answer "when did this pass run and what did it fix", and its answer was a row that began after its own work.

The id and the clock are minted together in one `start-run` step now (which replaces `mint-run-id`), as epoch milliseconds, because a journal round-trips JSON. Proved by driving a real interrupt-and-resume with a clock that moves six hours, and asserted over the work rather than over a constant: no row the run repaired was written before the run says it started.

The sweep found three more, in three capabilities. `TestersDailyWorkflow` read `new Date()` in its body, and `now` decides the day key every snapshot is written under — a pass that began at 23:50 and resumed after midnight wrote the cohorts it had finished under yesterday and the rest under today, and the darkness histogram cannot be recomputed after the fact. `EmailSendWorkflow` read its clock a frame down, inside `buildSendDeps`, so a batch resumed the next day dated its remaining jobs and every link expiry with it. `runAtRestKeyRotation` read one for the key version it stamps. All three are journalled. Leaderboard's `RankRefreshWorkflow` already did this correctly and is what the others now look like.

The gate is `packages/cli/src/ci/workflowDrivers.ts`, and it states where a value may be produced rather than listing the ways to produce one: **a driver body may not evaluate a nullary call or a nullary construction.** A call with no arguments cannot compute its answer from its input, so the answer came from outside the program — which closes over `Date.now()`, `new Date()`, `crypto.randomUUID()`, `performance.now()`, the injected `deps.now()` that no list of global names could have caught, and the sixth spelling nobody has written yet. A function-like node is a definition rather than an evaluation, so `now: () => new Date()` handed to a step stays legal and a `step.do` callback needs no special case; a call into the module's own functions is followed, which is how email's clock was found.

The population is discovered, never declared: every class extending `WorkflowEntrypoint`, plus every function taking a step runner — itself recognised by shape, as any interface whose one member is `do(name, callback)`. Fourteen Workflows and four delegates, asserted exactly and cross-checked against the `className` every `WorkflowSpec` declares, which is a second enumeration maintained for an unrelated reason. Three of the fourteen do not live under `src/workflows/`, so a gate that had globbed that directory would have covered eleven and reported itself green — pithy-sh/pithy#326 finding 4, avoided by asserting the set rather than a floor. Each of the four defects was planted back into the real tree and named with its file, line, driver and expression; a fifteenth Workflow was planted and the population assertion failed on it.
