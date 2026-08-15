---
"@pithy-sh/leaderboard": minor
---

One board that will not rank stops taking every other board's pass with it.

`runRankPass` swept retention, then ranked each materialized board in a bare loop. A board whose refresh threw discarded the prune count **and** every board already ranked in that pass — and the boards after it never ran. `pruneBoards` had the same shape one level down: one board's prune threw and the sweep lost the deletions it had already made.

Both loops guard per board now, and neither contributor is load-bearing. Pruning first is an efficiency — it keeps the refresh from spending a chunk ranking rows about to be deleted — not a precondition, so a failed sweep is no reason to leave every board's ranks stale. And boards are independent by construction: a board's entries, windows and ranks are its own, so a board that will not rank has no claim on any other board's pass.

**The state rides on the value.** A board that threw is not a board that ranked nobody — `ranked: 0` is a real answer about an empty window — so `RankPassResult.refreshed` is a union of `refreshed` (carrying the numbers) and `unavailable` (carrying none). A consumer reaches a count only by narrowing, and forgetting the sick board is a type error rather than a zero on a dashboard. `pruneBoards` answers the same way: `pruned` with a total, or `partial` with the total nested beside the boards it did not reach.

**Nothing from the throw travels.** Both guards take no binding. What survives is the board key and the window key, which are the adopter's own configuration; a D1 failure's own words name a query and an entry's identifiers.
