---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/organization": minor
"@pithy-sh/artifacts": patch
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/consent": patch
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

Every control-plane scope now says what kind of operation it is, so a management client can cap what an agent is granted, and a management client or `pithy dashboard connections --principal` can find and revoke everything one person authorized.
