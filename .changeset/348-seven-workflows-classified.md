---
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/media": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/vector": patch
---

Classify the remaining seven Workflows, and empty the backlog #338 left behind.

`classifiedSteps` has been the seam since #338, and two of the nine Workflows this kit ships used it. The other seven inherited the platform default — retry everything — so a closed cohort, a board whose CRON will not parse, a model pinned to the wrong dimensions and a media record that no longer exists were each backed off and re-driven as though the answer might change. Every one of them now states its own classification, in one file per capability, as a `code → reason` record: the argument for each retryable code is written down rather than implied by a throw site, which is what makes the decision reviewable.

Three of the seven retry nothing of their own, and that is the finding rather than an omission. Leaderboard's refresh, storage's sweep and testers' daily pass talk to D1 and to nothing else; core answers for D1 through `withD1Retry`, the cron is the outer retry, and each is idempotent — so a run that fails costs one interval and the next fire does the whole job. Their empty records are asserted, in both directions, so "retries nothing" cannot decay into "nobody looked."

The other four retry a dependency they do not control. Media re-drives an unreachable model, an unreachable Stream API, and a video whose asset is still encoding — enrichment is started once on finalize and never again, so a fault wrongly called terminal is an asset that silently keeps no alt text. Support re-drives a model that did not answer, which is the case `ai/classify.ts` already refused to swallow. Vector re-drives an embedding call, because a page is re-selectable until its upsert is accepted. Email's policy was already written and tested in `send/retryPolicy.ts`; this is the import.

Three capabilities needed a code before they could state one. Workers AI throws a raw `Error`, which `classifyWorkflowFault` reads as `unclassified` — terminal — so the one genuinely transient fault in a classification, an enrichment or a re-embed would have been the one that never got a retry. Each now wraps its binding call once, at its own seam, as `core/upstream_failed`: the same vocabulary secrets and payments already use, with the binding's own words in `detail`, which the HTTP codec strips. A model that answered *wrongly* keeps its existing terminal code — the split is by code, because a code is all the durable step can act on.

`core/src/workflow/retryClassification.test.ts` now holds one list instead of two. `UNCLASSIFIED` is gone with the last of its entries, and the gate is planted against on the real tree: a raw `step.do` restored to a shipped entrypoint fails it in both directions.
