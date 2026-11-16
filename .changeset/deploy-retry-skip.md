---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/cloudflare": minor
---

`pithy deploy` gets through a Worker's first deploy even when Cloudflare is slow to show the new Worker, and skips an app Worker whose built bundle and config are already live.
