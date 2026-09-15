---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

`pithy migrate` and `pithy seed` say what they are on, while they are on it.

On a remote environment every migration statement and every seeded row is a REST round trip. A run took
minutes and printed its first character when it had finished, so a slow schema change and a hung one looked
the same, and the instinct was Ctrl-C in the middle of it. Each step is now named as it starts, one plain
`▸` line: the check before the first write (`▸ Checking DB, SECRETS...`), each database and the Workers it
serves (`▸ DB (app) for api, collab...`), each migration (`▸ Applying 0300_auth_0001_init to DB...`,
`▸ Rolling back … on DB...`), and each seeded store (`▸ Seeding things on DB for api...`).

The end-of-run report is unchanged, byte for byte. `--json` prints none of it and still writes exactly one
line. A missing TTY prints all of it. Reading the ledger stays quiet, so `pithy doctor` and `pithy deploy`'s
pre-upload check are unchanged.

**The same lines now appear in every command that migrates or seeds as a side effect:** `pithy provision`,
`pithy add`, `pithy remove --drop`, `pithy upgrade --migrate`, `pithy feature create` and `pithy feature sync`.
Under `--json` they do not.

Core gains `beforeEachMigration`, the hook that hears each migration's name and direction ahead of its body.
It keeps a `down`'s retained declaration, which a hand-rolled wrapper would lose.

The gate that finds long commands by their captured subprocesses cannot see a command slow on REST. Migrate
and seed are held by runtime gates that require every round trip through their store seams to follow a step
naming that store. No other REST-bound command is held by anything, and `ci/narration.test.ts` says so.
