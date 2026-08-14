---
"@pithy-sh/core": minor
"@pithy-sh/secrets": patch
"@pithy-sh/payments": patch
"@pithy-sh/email": patch
---

Give Workflow steps a stated retry classification, and stop retrying answers that cannot change.

A Workflow is chosen because of its retry semantics. A step that inherits the platform default has not decided — it has deferred, and the default is retry-everything. So `create` refusing a secret name that already exists, which is the write path working, was backed off and re-driven as though the name might stop existing. Measured against a real Workflow in `wrangler dev`: the duplicate write errored after **32.2 seconds**. It now errors after **0.9**, on the first attempt.

`classifiedSteps` in `@pithy-sh/core/src/workflow/faults` is the seam. A capability states the error codes it retries and the reason a second attempt could answer differently; core answers for D1's vocabulary through the classifier `withD1Retry` already had, so a fault the inner layer refused to retry is terminal at the step too; everything else is terminal. Retry is opted into, never inherited. The conversion happens **inside** the step callback, because by the time a `step.do` promise rejects the retries have already been spent.

Secrets and payments state theirs — `secrets/already_exists` and `secrets/not_found` are terminal, an unreachable Cloudflare API is not; an unreachable store fails a reconcile page so it re-drives, every other refusal about a purchase does not. Email's is stated and tested in `send/retryPolicy.ts` beside the `E_*` table it agrees with.

`core/src/workflow/retryClassification.test.ts` is the gate: every Workflow entrypoint hands its step to the classifier and uses it nowhere else. It discovers the population from the tree, asserts it against two hand-written lists, and was planted against — a raw `step.do` and a newly added Workflow each fail it. The seven Workflows still on the platform default are listed there and tracked in #348.
