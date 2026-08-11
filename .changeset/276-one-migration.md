---
"@pithy-sh/audit": patch
"@pithy-sh/media": patch
"@pithy-sh/payments": patch
"@pithy-sh/cli": patch
---

A capability's schema is one migration, not a chain.

Nothing here has been published — every package is `0.0.0`, `npm view @pithy-sh/core version` is a 404, and the one adopter recreates its dev database in two minutes. A chain buys exactly one thing: walking a database that already holds rows from an old shape to a new one. There is no such database, so the three `0002`s were steps from a shape that never ran to a shape that never shipped, each carrying a second `down` and a second test suite for a history nobody will replay.

`audit`, `media` and `payments` now each carry their whole schema in one migration. The resulting schema is byte-identical to what the chain produced — `CREATE TABLE` text, column ordinals, every index and its column order, read back out of a real D1 before and after. Every assertion the deleted tests made is made against the merged migration, including the tenant column reading back as `null` when nobody states one, and each `down` is tested against a populated database rather than an empty one.

`media`'s migration is parameterised rather than chained: it creates the dedup hash table in both record-store modes and the record table only for `recordStore: 'd1'`, which is what the second migration used to select. Its adopter extension columns are now `0002_extend`, matching what they were always documented as.

`packages/cli/src/migrations/oneMigration.test.ts` states the rule as an invariant — every authored migration numbered `0001`, and no more migrations than a package declares databases — so `@pithy-sh/email`'s legitimate pair of `0001`s passes structurally rather than as a named exception. It skips any package that has been released, and goes quiet on its own the day the first version is cut. `CONTRIBUTING.md` §Migrations says why the rule is safe today and what replaces it after that.

A dev database migrated before this lands has the old keys in its ledger. Recreate it, or `pithy migrate --rollback` first.
