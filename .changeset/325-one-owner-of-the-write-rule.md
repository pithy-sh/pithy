---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

A global secret cannot be narrowed to one environment, and a fan-out that dies says what it wrote.

`pithy secrets update <global> --env staging` used to widen silently: `--env` was resolved to the
canonical environment before anything could refuse it, and the write went to every environment
including prod. It is refused now, before dispatch, with nothing sent — the re-run without `--env` is
the confirmation, and no flag skips it. `rm` gets the same answer, where it matters more.

The rule has one owner. `secretWriteTargets` decides where a write may land; `resolveWriteTargets`
stays the routing table underneath it and holds no policy. `dispatchSecretWrite` and
`mintDeclaredSecrets` both ask the rule, and a gate over the source fails the build on any shipped
module that reaches the table directly — the state this found, where each caller held a
cross-environment invariant on its own.

Complete-or-revert is not offered, because it does not exist: each environment is a separate Workflow
in a separate Worker, and a compensating write is itself a Workflow that can fail. So the fan-out
reports instead. `dispatchSecretWrite` grew the environments it wrote one at a time and lost all of
them to a throw; they now ride out on the error, reach the failure audit, and are printed before the
error with `"interrupted": true` under `--json`. The mechanism is `partialWriteReport`, shared with the
minting path rather than copied from it.
