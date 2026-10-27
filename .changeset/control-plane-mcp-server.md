---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/artifacts": patch
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/organization": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

`pithy` now ships an MCP server, so an agent can administer your Pithy application through the same scoped, audited control-plane seam the dashboard uses, with its tools discovered from what your Worker composes, on your machine with its own key or in CI with no key at all.
