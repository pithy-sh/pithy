---
"@pithy-sh/cli": patch
---

A scaffolded project can run its first `bun install`.

`pithy init` wrote `"@pithy-sh/core": "^0.0.0"` into `apps/<worker>/package.json`. Nothing under `@pithy-sh/*` is published, so the first command after scaffolding 404'd — and the link script an adopter would fix it with runs on `postinstall`, which is the install that just failed. The kit dependency is now stamped from core's own version, and while that version is `0.0.0` — the marker for "not released" — no range is written at all. The package resolves from a linked checkout either way; only the range fails. The first release makes the range real with no change here.

`pithy init` says where the kit comes from while it is unpublished, rather than leaving a 404 as the introduction.
