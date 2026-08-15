---
"@pithy-sh/cli": minor
---

A Worker that could not be reconciled stops erasing every other Worker's upgrade.

`runUpgrade` fanned out over `apps/*` building and applying one plan per Worker, in a bare loop. A plan reads that Worker's own `pithy.config.ts` and `wrangler.jsonc` and, through the ledger, its databases; an apply **writes** those files and, with `--migrate`, runs that Worker's migrations. Any of it can fail for reasons belonging to one Worker, and the throw propagated — so a five-Worker project lost four Workers' reports to the fifth's broken config, *after* some of those Workers' files had already been rewritten. Infrastructure changed, record gone.

This is `buildProjectHealth`'s defect at its twin, and worse for that reason. #371 fixed the one and not the other.

`UpgradeWorkerResult` is a three-state value now. `reconciled` carries the plan and what applying it changed. **`unplanned` carries the Worker's name and nothing else** — nothing was read about it and nothing was written for it, so there is no plan to mistake for an empty one. **`unapplied` carries the plan and no applied record**, because that Worker's files *have* been opened: its `wrangler.jsonc` may hold part of the plan and under `--migrate` its schema may have moved, and telling an operator to re-run against it as though it were untouched is the report this state exists to refuse.

Either failure still **exits 1**, on `pithy doctor`'s standard: a Worker that was not reconciled established nothing, and exiting 0 around it would be a weaker gate than the throw it replaces. Every *other* Worker now reports in full.

Resolving the Worker set stays unguarded on purpose. It decides *what* the run is over — the loop's input, not one of its contributors — so a `pithy.config.ts` that will not import still fails the whole run.

**Nothing from the throw travels.** Both guards take no binding. `pithy upgrade --json`'s `workers[]` entries lead with `state`.
