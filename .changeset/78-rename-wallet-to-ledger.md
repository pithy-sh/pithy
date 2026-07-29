---
"@pithy-sh/multiplayer": minor
"@pithy-sh/ledger": minor
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
---

`@pithy-sh/wallet` is now `@pithy-sh/ledger`.

A wallet sitting next to a payments capability invites the wrong inference — that a verified purchase tops up the wallet. It does not, and it never will: the two share no seam. `ledger` is what the thing has always been. The README's first line said so, the domain module said so, the migration said so. Only the package name did not.

The rename is total. Package `@pithy-sh/ledger`, capability `ledger`, tables `pithy_ledger_*`, migration namespace `ledger`, error codes `ledger/*`, admin scope `ledger:admin`, routes under `/ledger`. `@pithy-sh/multiplayer`'s wager seam follows: `WalletEffect` is `LedgerEffect`, `applyWalletEffects` is `applyLedgerEffects`. The migration order stays 650 — renumbering a released capability re-runs its migrations, so the constant was renamed, never renumbered.

Two names that stuttered under the new one are resolved. The migration is `ledger_0001_accounts`, named for the tables it creates, composing to `0650_ledger_0001_accounts`. The primitive moves up to `@pithy-sh/ledger/src/ledger` and is `openLedger(env.DB)`, so it no longer collides with the `ledger()` capability factory.

Nothing had been published, so there is no deprecation path and no adopter carrying `pithy_wallet_*` tables. That window closes at the first release; this is the last cheap moment to do it.

**Any database that already ran the old migration needs resetting.** The composed key moved from `0650_wallet_0001_ledger` to `0650_ledger_0001_accounts`, and Kysely refuses to migrate a database whose bookkeeping names a migration the provider no longer offers — `pithy migrate` fails with `corrupted migrations: previously executed migration 0650_wallet_0001_ledger is missing`. Nothing published is affected; what is affected is a dev machine or a preview environment migrated before this landed. Locally, delete the project root's `.wrangler/state` and migrate again — it is dev data, and no `down` exists for a key this branch no longer ships. For a provisioned feature environment, tear it down and re-provision.
