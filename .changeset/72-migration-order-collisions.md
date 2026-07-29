---
"@pithy-sh/media": patch
"@pithy-sh/wallet": patch
"@pithy-sh/cli": patch
---

Fix two migration-order collisions that broke `pithy migrate`.

Migration orders must be unique per database. `auth` and `media` both claimed 300, and `rating` and `wallet` both claimed 600 — so `pithy migrate` threw `duplicate migration order` for any project composing either pair. Storing media against an identity is the ordinary case, so the first pair broke most projects that used both.

Media moves to 350, after the auth tables its records reference. Wallet moves to 650. Nothing has been released, so no applied migration key changes.

The reason these survived is that every test composed synthetic capabilities and none composed the real set — the check in `createMigrationRegistry` only fires when a project actually pairs the two. A meta-test now reads every declared order out of the tree and fails on a duplicate within a database, and fails again if a new capability declares an order without registering it.
