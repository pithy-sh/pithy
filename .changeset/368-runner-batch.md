---
"@pithy-sh/core": patch
---

A migration applies in one round trip, not one per statement.

`kysely-d1` executes every compiled query as its own `prepare().bind().all()`, so a migration paid a hop to D1 for each `create table` and each `create index`. Composed, `replay/board` — audit, auth, secrets, email, payments — cost **104 round trips and 1,983ms per drop-and-rebuild** in the Workers runtime. It is now **24 and 355ms**: 5.6x, measured against that application and a real D1, not a synthetic one.

That cost lands hardest where the kit's own advice sends people. `CLAUDE.md` tells adopters to test against real D1 and KV rather than mocks, and an adopter following it pays this once per test that needs a clean database — in `pithy-sh/dashboard`, 78% of total wall time, and a 700–1,900ms setup floor that put ordinary test bodies within reach of the 5,000ms timeout. Two load-bearing gates there went intermittent on it before anybody measured the setup. The kit tells people to test this way; the cost of testing this way is the kit's to keep reasonable.

Each migration body now runs against a Kysely whose driver queues its statements and sends them as one `d1.batch()` when the body returns. `up` and `down` both, so `pithy migrate`, `--rollback`, `pithy seed --redo`'s reset and `pithy remove --drop` all benefit.

**Only DDL is queued, and that is the whole safety argument.** A queued statement's result is handed back before the statement has run, so it cannot carry rows, a row count or an insert id. The queue therefore takes only statements that have no such result to carry — `create`/`drop`/`alter` on a table, index, view, schema or type. Every select, insert, update, delete and raw `sql` template flushes the queue and then executes on its own, exactly as before, so a read always sees everything written before it. A migration mixing data with DDL is split into several batches; it is correct and faster, just not one transaction.

**Failure semantics changed, and for the better.** A migration that failed at its k-th statement used to leave statements 1..k-1 applied with no ledger row — a half-applied migration, the thing a chain exists to prevent. The batch is now the unit: a failure rolls all of it back and the ledger still records nothing.

**Nothing changed across a migration boundary, and nothing may.** Each `up`/`down` builds its own queue and flushes before returning; the ledger row is written afterwards on the ordinary path. A chain that fails at its third migration still has its first two applied, recorded, and named in the error. Batching across migrations would make a partial chain unrepresentable in the ledger, which is worse than slow.
