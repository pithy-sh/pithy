---
"@pithy-sh/auth": minor
---

better-auth moves to 1.7, and a gate now watches its schema.

**Adopters were already on it.** `@pithy-sh/auth` declared `^1.6.29` while `1.7.1` was published, and the repository's `bun.lock` — a dev artifact that ships with nothing — pinned `1.6.29`. So every test this package has ever run went against a version no adopter installs. A range that resolves to something new is silent by construction, which is the whole reason this went unnoticed.

Two schema changes came with it, and both are amendments to `auth_0001_init` rather than a `0002`, because nothing is published and no database holds a row to carry across.

**`pithy_auth_jwks` gains `alg` and `crv`**, both nullable, as 1.7's `jwt` plugin declares them. Without them every sign-in that minted a signing key died on `table pithy_auth_jwks has no column named alg`.

**`pithy_auth_accounts` gains `issuer`, and the pair `(issuer, accountId)` is now the account's identity**, with a unique index on it. A provider id is a name this project chooses; an issuer is what the identity provider calls itself — so two providers configured against one directory could assert the same `accountId` and land on two rows. Better Auth's own upgrade guide has existing deployments take a maintenance window, audit for collisions and backfill the column. Nothing here has been released, so it is simply declared.

**And the gate that would have caught both.** `betterAuthSchemaDrift.workers.test.ts` runs the migration and compares every column Better Auth declares for the kit's own plugin set against what the tables actually have. `pluginSchemaDelta` already asks `getSchema` this question for an *adopter's* plugin, subtracting the kit baseline — so the baseline was the one schema in this package nothing checked. It found `issuer` on its own, after the suite was already green: 419 tests passing and a column missing.
