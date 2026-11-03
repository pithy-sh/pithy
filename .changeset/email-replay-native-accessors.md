---
"@pithy-sh/core": patch
---

A Worker that composes more than one inbound mail handler stores its mail again, and a failure in any of them now logs the error it hit.
