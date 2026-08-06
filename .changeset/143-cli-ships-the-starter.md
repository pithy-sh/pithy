---
"@pithy-sh/cli": patch
---

A published `@pithy-sh/cli` carries the starter template it scaffolds from.

`pithy init` resolved `templates/starter` four levels up, at the repo root — outside the package. That
path exists in a checkout and nowhere else. `npm pack` listed 289 entries, 0 of them a template and 147
of them the CLI's own tests, so the first command an adopter runs could not work. The docstring already
admitted the gap and nothing implemented it.

The template stays a single copy at the repo root, vendored into the package by `prepack` and removed
by `postpack`. A committed second copy drifts from the one the tests hold to the kit's rules, and a
symlink into a sibling directory does not survive `npm pack`. `files` now allows `src` and `templates`
and excludes tests: 157 entries, 19 of them the starter, 0 of them a CLI test.

Resolution tries the packaged layout first and the workspace second, and says which install is broken
when neither is there. The test packs the tarball, extracts it, and asserts against *that* — the same
question asked of the checkout is the blindness that let this ship, green, for months.
