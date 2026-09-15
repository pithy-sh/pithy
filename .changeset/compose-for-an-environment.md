---
"@pithy-sh/cli": patch
---

A command about one environment composes each Worker for that environment. `pithy migrate --env`, `pithy upgrade --env` and `pithy deploy --env`'s pending count evaluated `pithy.config.ts` with `compositionEnvironment()` answering `undefined`, so a config whose migrations differ by environment was counted and migrated with the wrong set. They, `pithy provision`, `pithy dashboard connect` and `pithy dev` now compose through one primitive, `project/composeFor.ts`, which stamps `ENVIRONMENT`, re-reads a config this run already evaluated for another environment, and restores what it found.
