---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

A failed migrate names what failed, and doctor sees a ledger row nothing declares.

`pithy migrate` said, in full: *Migration run failed. Fix the migration. Run pithy migrate again.* No database, no migration, no cause — because the cause went to `detail`, which the terminal renderer never prints and the HTTP codec strips. Kysely had already named both. The runner now puts the migration, the binding it was running against, and what the runtime actually said into `message`, and keeps the throw-site half in `detail`: *Couldn't apply "0900_board_0003_broken" on DB. D1_ERROR: no such table: no_such_table: SQLITE_ERROR.*

And the state behind that particular failure was not a broken migration at all. The ledger held a migration the project had deleted, which Kysely reads as a corrupted chain and refuses the whole run over. `pithy doctor` called the same database `migrations none pending ✓`, because pending is declared minus applied and a subtraction cannot see an extra.

`readMigrationLedger` now asks both directions of one database in one read, and every caller takes the comparison rather than one side of it — `countPendingMigrations` is gone, replaced by `readProjectLedger`. `pithy migrate` refuses before it writes, at the same choke point that claims a database's owner; `pithy doctor` reports it on the `migrations` line and fails its exit. Both print the same sentence, from one writer: *DB records 0900_board_0002_tenant. This project no longer declares it.*

"Fix the migration" is the wrong remedy for that — no migration is broken — so the action line says which case applies, from what the tool already knows. On `dev` the store is Miniflare's under `.wrangler/state` and deleting it costs a re-migrate. Anywhere else it is a database with real rows in it, where the same advice would be data loss, so the line says to restore the migration or remove its `pithy_migrations` row instead.
