---
"@pithy-sh/cli": patch
---

`pithy add` now writes a test rate limiter with its `namespace_id`, so it typechecks, and fills the id into one written without it. Running it again no longer rewrites `wrangler.jsonc`.
