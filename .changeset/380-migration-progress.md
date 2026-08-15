---
"@pithy-sh/cli": minor
---

A migration run that dies partway says which databases it already moved.

`runGroups` is `pithy migrate`'s write half — the one loop every entry point that changes a schema comes through, in the file whose *read* half #371 fixed. It visited one database at a time with no record surviving a failure: the third database's pass threw, the first two were already ahead of it, and the per-Worker report that would have named them died with the throw. That record is the thing you need most when a run dies mid-fan-out.

The run still stops at the first failure and still throws — a pass that failed for a reason belonging to the whole run should not carry on writing to the databases behind it. What changed is that the report rides out on the failure, through the same `partialWriteReport` channel `mintDeclaredSecrets` carries its minted secrets on (#324). `migratedBeforeFailure(error)` reads back three things that share no entry: `migrated`, the per-Worker rows for every database whose pass completed; `failed`, the one it died on; and `unreached`, every database it never opened. An empty `unreached` means the failure was on the last database, never "nothing was scanned".

`pithy migrate` prints that to stdout before rethrowing, so the failure line on stderr, the exit code, and the report agree — `--json` carries `"interrupted": true` beside `failed` and `unreached`.

`scopedGroups`, `claimGroups` and `assertLedgerDeclared` stay unguarded. They decide what the run is over and whether it may write at all; `claimGroups` in particular is the choke point that refuses another project's database, and a guard around it would be a guard around the refusal.

**Nothing from the throw travels.** The guard takes no binding, and a database is recorded as its name and its binding — what a migration throws names a statement, a table, or an id.
