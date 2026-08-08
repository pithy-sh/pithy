---
"@pithy-sh/cli": patch
---

Say when a Worker's config will not import, instead of treating it as a Worker that declares nothing.

Since #179 a `cf-secrets-store` secret is materialised only from the registry, which means only if the Worker's `pithy.config.ts` imports. That is the right rule — a registry nobody can read has no honest answer about which secrets a Worker gets, and the previous answer came from the `dev.json` copy #179 exists to delete. But the failure reached every consumer as an *absent target*, and an absent target is also what a project that never composed `secrets` looks like. The two states were indistinguishable, so nothing reported the one that mattered.

`pithy dev` was where that landed. A project whose config had a typo had its `.dev.vars` regenerated down to its header, started the Worker with no bindings, and printed one line: `Starting replay-board.` Not a word about the config. `pithy seed` and `pithy doctor` both name an unloadable config for their own reasons and were never affected; `pithy dev` is the command an adopter is actually running while they edit that file.

`resolveDevSecretsTargets` replaces the array with `{ targets, unresolvable }`, so a failure is a field a caller has to drop on purpose rather than an absence it takes by default. `pithy dev` now says, every run until it is fixed:

```
replay-board starts with no bindings of its own: its pithy.config.ts did not import,
so nothing knows which secrets it declares and none reached apps/board/.dev.vars.
Could not load …/apps/board/pithy.config.ts. …
```

Consequence first, then the cause, in one sentence — the adopter is mid-edit with the wrong suspect in mind, and two facts in two blocks is them correlating it.

Resolution is also per Worker now. `resolveWorkers` fans out and throws on the first bad config, so one Worker's typo cost every healthy sibling in the project its registry, and therefore its secrets, for a file it does not own. A failure costs exactly one Worker.

A tripwire pins the four remaining callers of the lossy list — the three `pithy doctor` checks and `pithy add` — by name, so a fifth has to add itself and read why. This defect class reached four independent producers before anyone noticed; a count would have passed while one was swapped for another.
