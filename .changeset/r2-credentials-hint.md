---
"@pithy-sh/cli": patch
"@pithy-sh/storage": patch
"@pithy-sh/media": patch
---

A missing R2 key pair now points you at the account config, where Pithy reads it, rather than at `.dev.vars`, where it never looked.
