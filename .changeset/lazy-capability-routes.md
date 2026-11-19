---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
"@pithy-sh/email": minor
"@pithy-sh/secrets": minor
"@pithy-sh/turnstile": minor
"@pithy-sh/audit": minor
"@pithy-sh/consent": minor
"@pithy-sh/storage": minor
"@pithy-sh/media": minor
"@pithy-sh/leaderboard": minor
"@pithy-sh/multiplayer": minor
"@pithy-sh/rating": minor
"@pithy-sh/matchmaking": minor
"@pithy-sh/ledger": minor
"@pithy-sh/vector": minor
"@pithy-sh/payments": minor
"@pithy-sh/support": minor
"@pithy-sh/testers": minor
"@pithy-sh/organization": minor
"@pithy-sh/artifacts": minor
"@pithy-sh/cli": minor
"@pithy-sh/i18n": minor
"@pithy-sh/cloudflare": minor
---

A Worker loads each capability's routes, schemas and messages on the first request that needs them, not at startup, so it starts in a fraction of the CPU and stays well inside Cloudflare's startup limit. A capability built outside the kit hands core a loader for its routes; see the capability guide.
