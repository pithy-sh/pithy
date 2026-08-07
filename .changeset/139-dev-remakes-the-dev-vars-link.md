---
"@pithy-sh/cli": patch
---

`pithy dev` makes the `.dev.vars` link a fresh clone cannot inherit.

The project keeps one `.dev.vars` at its root and links it into each `apps/<worker>/`. Both the file and the link are gitignored, so neither can be committed. `pithy init` makes the link once, for the developer who created the project. Every developer after them clones, writes the `.dev.vars` the example tells them to, and wrangler reports every secret in it absent — the value present at the root, unreachable, and nothing in the project re-making the link.

`pithy dev` now re-makes it on every run, before anything reads a variable. It is the command that runs *after* the file exists — a `postinstall` runs before it, since the usual order is clone, install, then write `.dev.vars`, so the install that would have wired it had nothing to wire. It is idempotent, a no-op when the project has no `.dev.vars` at all, and it replaces nothing but a symlink: a worker holding a real `.dev.vars` of its own keeps it and is named in the output.

A scaffolded project no longer needs a `postinstall` script of its own for this.
