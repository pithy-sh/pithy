---
"@pithy-sh/cli": patch
---

`<config>/cloudflare.json` no longer deletes a `__proto__` key while promising it would not.

The schema's `catchall` says another tenant's key is "read and written back untouched", and for one key that was never true. `JSON.parse` gives `__proto__` an own property, because it must; Zod skips that key while building the object it returns, for the same reason; the read-modify-write then puts back what it was handed. Measured: the document states the key, the parse result does not, and nothing is reported in between.

Refused rather than preserved, on `@pithy-sh/core`'s `statesNoVanishingKey` and in front of the parse, where a key that has already vanished can still be seen. `__proto__` is not a name a future tenant will be called, and this file holds a live Cloudflare API token — a key deleted in silence there is not something to shrug at. A malformed document keeps its existing answer, which is a different failure with a different cost.
