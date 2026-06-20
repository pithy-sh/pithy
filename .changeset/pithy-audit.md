---
"@pithy-sh/audit": minor
"@pithy-sh/core": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/cli": patch
---

New package: `@pithy-sh/audit` — a D1-backed, queryable audit trail with a core emit seam and a CLI companion emitter, so both Workers and CLI commands record who did what, when, and whether it succeeded — attributed to the right CF actor. Core gains the `emit()` audit seam, the `audit/*` error codes, and the shared `withD1Retry` helper; `@pithy-sh/cloudflare` gains a user/token identity reader for actor resolution.
