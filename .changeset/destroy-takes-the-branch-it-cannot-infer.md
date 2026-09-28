---
"@pithy-sh/cli": minor
---

`pithy feature destroy --branch <name>` names the feature, so a merged pull request can tear its own environment down.

Teardown inferred the feature from `git rev-parse --abbrev-ref HEAD`, which is the one thing the caller that most needs it does not have. On `pull_request: closed` the branch is already deleted and `refs/pull/<n>/head` checks out detached, so `--abbrev-ref` answers `HEAD` and the command refused with `Not on a feature branch (HEAD).` A feature deployment provisioned from a branch therefore outlived the branch: every merged PR left its Workers, databases, store entries and Workflows on the account until somebody recreated the worktree by hand. The same shape as #637 — the only command that frees a thing could not be reached once the thing it needed was gone.

The pipeline was holding the answer the whole time. `github.event.pull_request.head.ref` is `feature/112-bootstrap`, and it survives the branch's deletion because the event payload is a snapshot.

`--branch` takes that string and parses it with **the same `parseFeatureBranch` the inferred path uses** — one parser, so the two cannot come to disagree about what a feature is called, and one refusal table, so they cannot disagree about saying a name is not one either. A malformed name is refused before the project config is opened, let alone before anything is deleted. Only the issue and the slug come from the flag: the **project** still comes from the checkout's own `pithy.config.ts`, which is the first segment of every resource name teardown recomputes, so the flag names a feature *of this project* and cannot reach another's. With no `--branch` the checkout's branch decides, exactly as before. `provision` and `create` are unchanged; teardown is the only half with a caller that cannot stand inside the worktree.

**The local half is now a truthful no-op rather than a claim.** `portsFreed` was the literal `true` — a statement about a registry nobody had read — and a runner holds no port block and no worktree at all, both being machine-local. `freePortBlock` answers whether a block was actually there, the report carries that answer, and a run with nothing local to do says `No port block and no worktree here. Nothing local to tear down.` and exits 0 having done the remote half. The same change makes the failure #435 describes visible from the report: a free that no-ops under the wrong registry key no longer reports success over a block that leaks for the life of the machine.

One more thing `--branch` does not do: remove the wrong `.dev.config.json`. That file is a *worktree's* port claim, and under `--branch` the working directory belongs to some other branch — a runner's checkout, or a developer's main — so teardown looks for the feature's own worktree instead, and finds nothing on a runner.
