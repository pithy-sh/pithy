---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/secrets": minor
---

Mark a field `encrypted()` and it rests in D1 as an AES-256-GCM envelope bound to its row, findable by an optional blind index, and re-sealed onto each new key version by the nightly rotator, which retires the old one once nothing needs it.
