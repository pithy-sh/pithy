---
"@pithy-sh/cli": patch
---

Every dev secret is encoded for `.dev.vars`, and reaches the Worker that reads it.

wrangler parses `.dev.vars` with dotenv, whose unquoted grammar ends at the first `#`. A value with one
in it was truncated silently and failed at the first request looking present. And the line was written
to the project root, which `pithy dev` never gives the Worker: wrangler runs in `apps/<worker>` and
reads the file beside its own config. One writer now does both, verified against wrangler's own parser.
