---
"@pithy-sh/cli": patch
---

The port-registry lock's retry budget is injectable, so a test stops racing its own timeout (#194).

`LOCK_MAX_ATTEMPTS` (50) × `LOCK_RETRY_DELAY_MS` (100) is 5000ms, and 5000ms is vitest's default
timeout to the millisecond. `ports.test.ts > lock staleness > does NOT reclaim a fresh lock` asserts
that a lock still inside its staleness window is not stolen, so it must exhaust every retry to pass —
and exhausting them costs exactly the timeout. It passed on an idle machine, failed on a loaded one,
and #173 made this suite run on every pull request.

`allocatePortBlock`, `freePortBlock` and `reclaimPortBlocks` now take an optional `lock` budget.
Production values are the defaults and nothing in the CLI passes it; the test passes three attempts at
10ms and runs in 33ms instead of 5028. The assertion is unchanged — a fresh lock survives a spent
budget, whatever its size — and still goes red if the reclaim is made unconditional.

The refusal now names the budget it actually spent rather than the constant, and the defaults are
asserted, so the seam cannot become a way for production to acquire a different one quietly.

Three other retry loops in the CLI have production constants of the same shape — `verifyDeploy`'s
5 × 1000ms, `vectorProvisioner`'s 10 × 1000ms, `orchestrator`'s 5000ms shutdown grace. All three
already inject their sleep, and no test in the tree waits on a real one. This was the only holdout.
