---
"@pithy-sh/core": minor
"@pithy-sh/audit": minor
"@pithy-sh/cli": patch
---

New in `@pithy-sh/core`: a two-mode `Logger`. Mode one unifies local CLI and Worker diagnostics — human-readable, or `--json` for agents. Mode two emits structured, request-correlated records with Cloudflare Workers Logs on by default and a tail/Logpush hook. Capabilities resolve `c.var.log` instead of calling `console`, and the `@pithy-sh/audit` recorder now logs through it.
