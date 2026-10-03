---
"@pithy-sh/support": minor
"@pithy-sh/cli": minor
---

The support full-text index is now maintained by database triggers rather than by hand at every write path — re-run `pithy support provision` after upgrading, and `pithy doctor` will name any project that has not.

Two things are new to adopters. The durability contract inverts: a trigger runs inside the message's own statement, so a failed index write now aborts the message write where it used to log a warning and carry on. And `pithy doctor` gains a `Support search:` block, which reports a provisioned `pithy_support_search` with no triggers as drift, per environment, and says so explicitly when it was offline or had no credentials rather than reading clean.

`indexMessage` and `reindexThread` are retained and exported. Nothing public is removed.
