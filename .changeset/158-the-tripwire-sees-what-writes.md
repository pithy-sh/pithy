---
"@pithy-sh/cli": patch
---

Two more escapes, and a tripwire that can see the shapes it was missing.

`pithy worker add` wired a `.dev.vars` symlink through a symlinked `apps/<worker>`. The wiring runs over
every worker *discovered*, not just the one being added, and discovery reads `apps/` through whatever is
there — so a link planted at `apps/other` put a `.dev.vars` inside a directory outside the project.
Where the shared file lives outside the tree, that link is written absolute and points straight at
`CLOUDFLARE_API_TOKEN`. Reproduced with the real CLI. `pithy dev` runs the same wiring every time.

`pithy init` read "git could not answer" as "this is the vendored template" and fell back to copying the
directory as it sits. That is right for an installed package and puts #145's leak straight back on a real
checkout where git is missing or the repository is broken — `.dev.vars` and all, silently. The two states
are now told apart by which layout the template resolved from, which the resolver already knew.

The tripwire itself had two blind spots, both self-reported. It defined "a module that writes" as one
importing `node:fs`, so `ui/flow.ts` — which probes with `access` and writes through `scaffoldFiles` —
was never examined; this package's own writers now count the same. And nothing anywhere noticed a
recursive `rm` on a path built out of a name, which is exactly what #158's two producers were. Both are
gates now, and each exemption has to be written down.
