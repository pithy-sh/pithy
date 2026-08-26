---
"@pithy-sh/cli": patch
---

`pithy feature create` cuts from local `main`, and a failed create can be destroyed.

The base was `origin/main` whenever that ref existed, so a repository holding unpushed work started every
feature before that work — 159 commits, on the adopter that found it. The symptom was a config error
naming a field the branch was too old to have, which says nothing about the base; where the older tree
still loads there is no symptom at all and the branch is simply rooted in the past. It cuts from local
the local trunk now — named by `origin/HEAD` so a repository whose trunk is `master` is not handed a
stale local `main` — reports how far behind its remote that trunk is rather than refusing, and falls back
to `HEAD` where there is no local trunk. The report carries the ref it cut from, and it is null when
nothing was cut: an attached branch's base is whatever somebody else chose, so the behind-remote line is
not printed over it.

`pithy feature destroy` no longer needs a Worker config to load. Its local half — free the port block,
prune the worktree — is derived from the branch and the root config, which is what the state it exists for
demands: a create that failed partway leaves a worktree whose config throws, and teardown used to throw on
the same config before reaching it. The block leaked to a branch that no longer existed. The remote half
still cannot run without those configs, so an unloadable one is refused unless `--local-only` says the
remote half is not wanted.
