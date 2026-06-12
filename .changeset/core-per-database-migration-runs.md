---
"@pithy-sh/core": minor
---

Per-database migration runs. `createMigrationRegistry` now produces one ordered migration provider per database — matching multi-database D1 — with stable keys and core-before-app ordering preserved per database.
