---
"@pithy-sh/cli": patch
---

`pithy` now writes `wrangler.jsonc` and `.dev.vars` atomically and through one shared helper, so a crash mid-write can't corrupt them and config formatting stays consistent across commands.
