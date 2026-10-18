---
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/leaderboard": minor
"@pithy-sh/ledger": minor
"@pithy-sh/rating": minor
---

Server-authoritative writes work. Supply `resolveScopes` and the leaderboard, rating and ledger gates finally have something to check — they have refused every caller since they shipped. Reach the seam over a service binding and there is no credential to steal; over mTLS and the edge refuses a caller without a certificate; anywhere else with a short-lived token bound to your own origin.
