---
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/secrets": patch
"@pithy-sh/rating": patch
"@pithy-sh/leaderboard": patch
---

No statement binds more than D1 accepts.

D1 takes 100 bound parameters. Five capabilities bound a variable number into one statement without asking, while the arithmetic to avoid it sat in `core`'s `boundParameters.ts`, unimported. The primitive was never missing. It was never called.

- **email** — the scheduler's claim bound two fixed parameters plus a batch sized by `SCHEDULER_BATCH_SIZE`. The default of 50 was safe; 100 bound 102 and every cron tick failed. A typo in that variable was worse: `NaN` produced one empty batch, so nothing was claimed, nothing was sent, and nothing said so.
- **secrets** — `getValues` read every D1-backed secret the registry declares in one statement. An app declaring 101 of them could read none, and since every capability's secrets resolve through that one call, that is a Worker that does not start.
- **rating** — `getMany` bound one parameter per player. `players` has a minimum of two and no maximum, and the docs promise any count, so a 120-player game failed every `recordResult`.
- **leaderboard** — the rank refresh declared its own copy of D1's cap and a chunk size hand-derived from it. `RefreshOptions.chunkSize` was unvalidated: `40` bound 120, and `0` reported a board complete having ranked nobody.
- **leaderboard, again** — a segment is a caller-supplied list. The HTTP route refused an oversized one; `topEntries` and `rankOf` are exported, and a direct caller's 120-friend segment reached D1 with 124 parameters.

All five now go through `boundParameters.ts`. The private chunker is gone, and so is the duplicated constant.

Two operator-supplied numbers had no ceiling, and neither has one now — the statements size themselves, so `SCHEDULER_BATCH_SIZE` is purely a fan-out knob and `chunkSize` purely a pacing one. What each refuses is a value that is not a count at all, named at the boundary, because there is no safe number to clamp a typo to.

**The rule moved to the thing being called.** `createDatabase` — the one seam every Kysely instance in the kit comes from — now refuses a statement over the cap at `D1PreparedStatement.bind`, where the count is what the driver hands the platform rather than what a caller intended. A query site cannot opt out, and one that has never heard of the limit is covered anyway. The failure names the rule instead of leaving `too many SQL variables` for somebody to trace back to a list.

The gate states the invariant rather than a file list: no statement this repository executes binds more parameters than D1 accepts, at any width. A gate naming the four known producers would have gone green the moment a fifth appeared — and a fifth appeared within a week of the fourth being fixed.
