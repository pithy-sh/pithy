---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/email": patch
---

Write every binding a capability requires, so a scaffolded project boots.

`pithy init`, `pithy add email`, `pithy add auth`, `pithy dev`, `curl /health` — the shortest path through the product, in the order the docs teach it — answered `500` on **every** route. `@pithy-sh/auth` requires `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` requires `workflow:EMAIL_SENDER`, both non-optional, the composition correctly refused to assemble without them, and nothing wrote either one. Because it is every route, `/health` failed too, so the error named a binding and never the capability behind it.

Both are now written by `pithy add`, per environment. A rate limiter is a policy with no resource behind it, so it lands at 100 requests per 60 seconds and is yours to tune. A Workflow entry names the capability's host across scripts — `<project>-<env>-<capability>-<job>` in `<project>-<env>-<capability>` — which is derivable offline, so the binding exists before `pithy <capability> provision` deploys the host. `vectorize` and `secret` stay unwritten and stay in `notes`: wrangler refuses a `vectorize` entry with no `index_name`, and a Secrets Store entry has no array in `wrangler.jsonc` to sit in.

`isWrittenBinding` in `@pithy-sh/core` is the rule, and `capabilities/requiredBindings.test.ts` is the gate over it: a capability requiring a kind that neither `add` writes nor a provision command creates fails CI rather than a request. `project/scaffoldBoot.test.ts` runs the whole path — scaffold, add, compose, `GET /health` — with the Worker's env built from the files the commands wrote and nothing else, which is the gap the defect lived in.

`pithy add` and `pithy upgrade` now write bindings through one function rather than two copies "kept in lockstep by intent". The two had already drifted: `add` stamped a capability's `remote` flag and wrote the Workers AI binding, `upgrade` did neither.
