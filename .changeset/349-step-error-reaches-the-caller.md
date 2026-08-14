---
"@pithy-sh/cloudflare": patch
---

Report the sentence a Workflow step raised, not the platform's prose about durable execution.

The Workflows engine writes its own error over the instance when a step raises `NonRetryableError`. So the moment #338 made a duplicate `pithy secrets create` terminal — 32.2 seconds down to 0.9 — the answer it gave stopped being about the secret. `dispatchAndPoll` now reads the failed step out of `steps[]` and reports what it raised. **`Secret 'api-token' already exists.`**, where the run before said `Workflow replay-staging-secrets-write did not complete (errored).`

Read in the primitive, so every dispatch that polls a Workflow gains it at once — secrets write and probe, payments reconcile, vector reprocess.

A step's text is promoted into the public `message` only when it is provably one the kit authored: a `PithyError` by name, or the `<code>: <message>` shape `classifiedSteps` writes. A foreign throw, a bare string, and the engine's own prose stay in `detail`, which the HTTP codec strips. Nothing that was not already public becomes public.

`stepFailure.test.ts` is the gate. Its instances are not illustrations — they were read off a real Workflows engine under `wrangler dev`, and it fails if a platform sentence reaches an operator in place of a step's. It was planted against: reporting the instance error turns all five captures red.
