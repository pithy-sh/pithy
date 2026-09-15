---
"@pithy-sh/cli": patch
---

A deploy reports an address, not an address wearing the sentence's punctuation. The public URL and the version id are scraped out of wrangler's own output, and `\S+` was taking whatever wrangler wrapped them in — `https://staging.app.pithy.sh")` was printed as the place a Worker had been deployed to, and it reaches nothing when copied or clicked. A bracket the address itself opened is kept, so a path ending in one survives.
