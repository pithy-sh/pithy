---
"@pithy-sh/core": patch
"@pithy-sh/cloudflare": patch
---

Carry a terminal Workflow step's `action` to the operator, so the remedy survives the boundary.

#349 got the step's sentence to the CLI. The line under it still died at the step: the engine records a throw's message and nothing else, and `classifiedSteps` wrote `${code}: ${message}`, so `SecretAlreadyExistsError`'s ``Use `update` to change an existing secret.`` had no field to ride in. A duplicate `pithy secrets create` said what was wrong and not what to do, where every other `PithyError` reaching the CLI says both.

The encoding is a stated separator — one newline — and it lives in `@pithy-sh/core`'s `workflow/stepMessage.ts`, written by `classifiedSteps` and read by `@pithy-sh/cloudflare`'s `kitSentence`. One statement, two callers, no restatement. JSON was the other candidate and lost on the surface nobody controls: a step's raw text is read by a human in the Cloudflare dashboard, and a JSON blob there is worse than the two lines it would replace. A newline rather than a printable delimiter because a promoted message may not contain one — the rule #349 already enforced — which is what makes the split total instead of best-effort. With no action the wire is byte-identical to what #349 captured.

Driven through the real CLI against a real local Workflows engine, `pithy secrets create` on a name that already exists now prints

```
Secret 'api-token' already exists.
Use `update` to change an existing secret.
```

A step that states no remedy still prints one line and nothing after it — no empty line, no trailing separator, no `undefined`. `detail` does not cross, is not read into the encoding, and has no field to cross in.

The gate is in `stepFailure.test.ts`, where both ends meet: the real `classifiedSteps` must produce a hand-written wire, and that same wire must read back as the stated sentence and action. Neither end can move without moving the literal. It was planted against — changing core's separator turns eight tests red across both packages.
