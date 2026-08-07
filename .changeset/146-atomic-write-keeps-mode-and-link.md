---
"@pithy-sh/cli": patch
---

An atomic write keeps the file's permissions, and its link.

`writeFileAtomic` wrote a `.tmp` sibling and renamed it over the target. A rename replaces the target completely, so everything the target *was* had to be carried onto the temp file first. Two things were not, and both failed in silence.

**Its mode.** `pithy init` chmods `.dev.vars` to `0600`. The first `pithy add` or `pithy token mint --store dev-vars` wrote through here and handed it back the temp file's `0664` — at exactly the moment it started holding `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`. The mode of an existing target is now kept, and `writeFileAtomic` takes the mode to *create* one with; every `.dev.vars` this CLI creates is `0600`. The temp file is created restricted rather than widened after the write, so the secret is never on disk world-readable, not even briefly.

**Its link.** `apps/<worker>/.dev.vars` is a symlink at the project's shared file. A rename over a symlink does not follow it — it deletes it and leaves a private regular file holding a stale copy. That made this the third producer of the loss #142 was filed about, and the one that survived the fix: the wiring afterwards correctly sees a regular file, reports it `kept`, and never repairs it, so the worker silently stops seeing every secret the shared file gains. Links are now resolved and written *through*; a dangling one has its destination created rather than the link replaced, and a chain that loops is refused.

**One policy for a symlink that points somewhere else.** The wiring replaced any link it found, which `pithy dev` — running it on every start since #139 — turned into a daily silent undo of a link a developer deliberately pointed elsewhere. Nothing that reaches a real file is replaced now, a link no differently than a file: a link decides which secrets a worker runs with, and swinging it back is the same substitution by another route. A link is re-pointed when, and only when, it reaches nothing — the dangling case, which is the one the wiring exists to repair. A link already reaching the shared file is left alone rather than re-created, which closes a window where the worker had no `.dev.vars` at all.

`kept` carries which of the two it was, and where a link goes. `pithy dev` names both. `pithy worker add` was dropping the list entirely, so a sibling keeping its own `.dev.vars` went unmentioned by the command that found it; it is in the report now, and in `--json`.
