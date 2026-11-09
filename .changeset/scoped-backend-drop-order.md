---
"@pithy-sh/auth": patch
---

`prepareScopedBackend` drops an app's tables children first, so a table that references two others no longer breaks the next test.
