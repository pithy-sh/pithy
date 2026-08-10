---
"@pithy-sh/core": patch
---

A seed group sizes itself against D1's bound-parameter cap.

`seedD1Group` bound every row of a group into one statement. D1 accepts 100 bound parameters, and an insert binds one per column per row, so the real ceiling was about fifteen rows on a seven-column table — and it moved with the table. Over it, `too many SQL variables`.

Every fixture the kit ships is 2–6 rows, which is why this survived. It appears the first time a fixture is big enough to do the job fixtures exist for: `DEFAULT_PAGE_SIZE` is 25, so anything proving a paged list crosses the limit by construction. `pithy-sh/dashboard` hit it on its first realistic seed and split fourteen tables into twenty-nine groups by hand to get around it.

The group is now written in chunks through `chunkRowsByBoundParameters`, sized from the row's own column count — the union of every row's keys, since that is what Kysely builds the column list from. Nothing about a fixture has to know the limit exists, and no adopter has to re-derive it after a confusing failure.

Chunks are written in sequence and a group is not atomic across them. `INSERT OR IGNORE` is what makes that safe, and it is the same property that makes seeding re-runnable at all.

The test asserts the invariant rather than a size: no statement the writer executes binds more than D1 accepts, at any width, at any length — measured at the D1 binding, so it holds whatever the writer does internally.
