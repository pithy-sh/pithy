---
"@pithy-sh/artifacts": minor
"@pithy-sh/audit": minor
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/leaderboard": minor
"@pithy-sh/ledger": minor
"@pithy-sh/matchmaking": minor
"@pithy-sh/media": minor
"@pithy-sh/multiplayer": minor
"@pithy-sh/organization": minor
"@pithy-sh/payments": minor
"@pithy-sh/rating": minor
"@pithy-sh/secrets": minor
"@pithy-sh/storage": minor
"@pithy-sh/support": minor
"@pithy-sh/testers": minor
"@pithy-sh/turnstile": minor
"@pithy-sh/vector": minor
---

Mark a field `pii`, `phi`, `secret`, or `pci` and it can no longer reach a log, an audit record, or an error detail — the call stops compiling, and `redact` gives you the masked view instead. Declare your classes with `pithy privacy enable` and `console` closes, deploys refuse to ship past it, and your control plane reports exactly which schemas and fields hold what — derived from the running code, so unmarking a field is a change leadership can see. `pithy privacy scan` suggests what to mark. It never decides for you.
