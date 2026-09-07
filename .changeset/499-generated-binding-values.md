---
"@pithy-sh/cli": patch
---

`pithy doctor` reports a generated binding value the kit has since changed its mind about.

A rate limiter's `namespace_id` is derived from its binding name, so two limiters can never share one budget. The docstring said that stability was also "the same across `pithy upgrade` retrofitting an older project", and that retrofit does not exist: the entry is written once at `pithy add` and never revisited, so a project scaffolded before the derivation keeps the id the old positional counter gave it — `1001` where the kit now writes `3093`. The claim is corrected, and the divergence is no longer invisible.

Nothing rewrites the value. A `namespace_id` is a live budget's identity, so changing it re-partitions traffic that is already flowing, and a value an adopter tuned is indistinguishable from one that merely predates a change. So doctor states both numbers, names the environments carrying it, and leaves the decision alone — it never fails the exit, and offers no command, because there is none.

`pinnedBindings: { AUTH_RATE_LIMITER: "reason" }` on a Worker's `pithy.config.ts` settles the line, the way `declinedBindings` settles a deliberate absence. The reason is required for the same reason it is there: a pinned value still prints, with the adopter's sentence where the instruction was, so the next person reads a decision rather than a difference. A pin whose value already matches, or which names nothing this Worker composes, is reported as stale and stays green.

The comparison is scoped to values the kit owns. A limiter's `limit` and `period` are the adopter's to tune, a D1 `database_name` is a proposal, and a `workflows` entry already has its own line — none of them is reported here.
