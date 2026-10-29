---
"@pithy-sh/cli": patch
---

A new project's `.dev.vars.example` no longer tells you to put your Cloudflare token in the checkout. It points at `pithy cloudflare connect`.

Security: The starter told every new project to put its bootstrap Cloudflare API token in `<root>/.dev.vars`, inside the checkout, where a package with a `files` list can pack it and nothing reads it.
