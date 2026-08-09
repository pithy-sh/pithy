---
"@pithy-sh/cli": patch
---

Four `--json` key names carried two types each. Each now names what it holds.

`if (result.removed)` was true for `pithy alias --remove`'s `boolean` and for `pithy feature sync`'s non-empty `string[]`. `result.revoked` was a yes/no on `pithy dashboard revoke-key` and a count on `pithy token revoke`, where `0` is an ordinary answer and `false` is a different claim. Neither reading errors; both just answer wrongly. Renamed on the outlier's side, before publication freezes them:

- `pithy feature create --json` reports `worktreeCreated`, not `created`. `pithy ui add --json` emits a `created` of its own that is the list of files it wrote — one name for "what was created" and for "whether it was". The subject is already in the payload beside it, and `feature destroy` had settled the convention anyway with `portsFreed`, `worktreePruned` and `branchDeleted`.
- `pithy feature sync --json` reports `addedWorkers` and `removedWorkers`. `removed` is a `boolean` on `alias` and on `dashboard disconnect`; this is a list of worker names. `added` is renamed with it because the two are read together, and half a qualified pair invites the misreading the qualification is for.
- `pithy feature destroy --json` reports `deletedResources`. `pithy vector reset --json` emits `deleted` as a `string[]` of index names where this is `{kind, name, id}[]` — two collections under one name, the harder half to notice, since both are truthy and both have a `length`. It also now sits opposite `feature provision`'s `resources`, which is the list it undoes.
- `pithy token revoke --json` reports `revokedCount`. Every other `<verb>ed` key in the CLI is a boolean.

A fifth, `skipped`, was not a collision at all. `payments reconcile` and `vector reprocess` each pass a deployed Workflow's return value straight out under `report`, and their pages spell out what that object holds — `pages`, `scanned`, `skipped` — in a second table. The scan that records shared names was reading that table as the command's own keys. The CLI has one top-level `skipped`, on `pithy ui add`, and it is unchanged; the scan reads the table header now, which also drops `pages` and `scanned` from the shared register and narrows `dryRun` to the two commands that really share it.

The register gained the half of "one key, one meaning" that is decidable. Every shared name's **type** is declared and asserted against the pages, so two pages describing one key differently have to be read together before either lands. Four names still disagree and are listed with the types they disagree on, rather than muted: `alias`, `project` and `workers` are all one shape — `pithy doctor`'s and `pithy dev`'s payloads are reports, and a report's blocks take the bare noun a result elsewhere spends on a scalar — and `environments` is a `string[]` of names in four commands and an `object[]` of records in `secrets status`.
