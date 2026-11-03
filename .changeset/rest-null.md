---
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

A null the CLI writes to a deployed database is stored as a null, not an empty string.
