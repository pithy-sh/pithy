---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/audit": patch
"@pithy-sh/email": patch
"@pithy-sh/media": patch
"@pithy-sh/payments": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/vector": patch
---

A Worker that owns its database gets its own capability hosts, so its email sends and its audit chain is checkpointed.

Security: A Worker that owned its database never had its audit chain checkpointed, so a change to its audit rows went undetected.
