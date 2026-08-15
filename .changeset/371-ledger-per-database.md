---
"@pithy-sh/cli": minor
---

A database whose ledger will not read costs its own entry, not the project's.

`readProjectLedger` fanned out over every database an environment declares and summed what it found. One unreachable D1 — a revoked token, a database deleted out from under a `wrangler.jsonc` — threw out of that loop, and the whole comparison was lost: every other database's pending count and every undeclared migration it had already found went with it. `pithy doctor`'s migrations line, `pithy upgrade`'s plan, and `pithy deploy`'s schema-is-behind warning all read that one call.

Each database is read under its own guard now, and a database that will not answer is **named** rather than absorbed into a smaller sum.

Guarding the loop was only half of it. A sum over four databases out of five is not the same number as a sum over five, and `{ pending, undeclared }` had no way to say so — so `pending: 0` about a project whose D1 was unreachable read exactly like a project that was level. `ProjectLedger` is a three-state value now: `read` carries the counts flat, `partial` nests them under `counted` beside the databases it could not include, and `unavailable` carries no number at all. The states share no field, so `ledger.pending` does not compile without narrowing and a short sum cannot be read as a whole one.

Enumerating the databases stays load-bearing and still throws. `contextFor`, `scopedGroups` and `driverFor` decide *what* the aggregate is over, so their failure is not one contributor missing — it is there being nothing to aggregate.

**Nothing from the failure travels.** The guard takes no binding, and an unreadable database is recorded as its name and its binding — the two facts an operator can act on. What a D1 read throws names an id, a token, or a query.

`pithy upgrade --json`'s per-Worker plan replaces `pendingMigrations` with `ledger`; `pithy doctor` prints which databases went unread and says that every number beside them excludes those.
