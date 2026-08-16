---
"@pithy-sh/auth": patch
---

Move the `better-auth` floor past GHSA-qq9h-g4jm-xgf3.

The declared floor was `^1.6.19`, inside the vulnerable range of a high-severity
account-takeover advisory patched in 1.6.22. The kit is not itself affected —
`emailAndPassword` is never enabled, and the attack needs it — but an adopter who
turns it on resolves better-auth through this floor.
