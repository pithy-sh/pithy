---
"@pithy-sh/cli": minor
---

`pithy doctor` lists the dev-port registry, not just its address.

The `Ports:` line printed a path in `~/.config` and stopped there, so "why is this project on 8847" had no answer short of `cat`. It now prints what is in the file: this checkout's blocks first and unqualified, then every other checkout on the machine, each named by the path that holds it.

Ranges, never block indices. A block's ports are `base + index × size`, so the index is the whole answer only while every entry is the same width — and a registry written before the width changed keeps its old entries verbatim. `8807–8826` is legible across both, and it is the form the question arrives in: the port you are looking at is the one `pithy dev` just refused to bind.

`← not on disk` is the one line here anybody can act on. Pruning cannot tell a deleted checkout from a moved one, so a renamed repository has its blocks freed by the next allocation any project makes, and nothing anywhere reported that it happened. This row is taken before the sweep.

Which blocks are yours is `registryRootFor`, the one function `pithy dev` allocates under — `git rev-parse` first, the project's own canonical path where there is no repository. Two derivations of that key is a report that calls your own block somebody else's, which is what a machine with no `git` used to get.

Nothing new is recorded to support any of it — the registry was already `root → branch → block`. Nothing here can fail the exit either: every line reports a location, and a stale root is information, not drift. `--json` carries the whole registry, absolute paths, on `portsRegistry.entries`.
