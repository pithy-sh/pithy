---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
---

`pithy migrate --env` now promotes migrations to staging and production over the D1 API, and `pithy deploy` ships your Workers to Cloudflare — both runnable by hand or in CI. The migration bookkeeping tables move to `pithy_migrations` / `pithy_migrations_lock` so they never collide with an adopter's own Kysely migrations.
