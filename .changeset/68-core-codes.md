---
"@pithy-sh/core": patch
---

Add the `rating/*` and `matchmaking/*` error codes to the `ErrorPayload` union, so the two new capabilities throw namespaced, wire-safe errors like every other.
