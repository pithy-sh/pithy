---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/leaderboard": minor
---

Seed any test environment from your own Zod-typed fixtures — local or live — with `pithy seed`. Author a `defineSeed` set once and it composes library-before-app, exactly like a migration, validating every row against your real table schemas before a single insert runs. D1 and KV writes are idempotent and never destructive; media assets upload to Images or Stream once and record their UUID for every run after. Production stays opt-in twice over: a set must list it explicitly, and the command still refuses without an exact confirm phrase.
