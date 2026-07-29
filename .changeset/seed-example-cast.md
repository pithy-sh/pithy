---
"@pithy-sh/multiplayer": minor
"@pithy-sh/leaderboard": minor
"@pithy-sh/ledger": minor
"@pithy-sh/audit": minor
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
---

Example seeds now come as a connected cast. `@pithy-sh/core` exports `EXAMPLE_IDENTITIES` — three canonical test users — and each capability's `example` seed set references them: `auth` seeds the users, `leaderboard` their scores, `ledger` their balances, `multiplayer` a match between them, and `audit` a timeline of security events attributed to them (for the dashboard). Turn on `seed.includeExamples` and a fresh backend comes up with the same three people owning connected data across every table, not scattered rows. Each capability reads the ids from core, never from another capability, so the cast couples nothing.
