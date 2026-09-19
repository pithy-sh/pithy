---
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/organization": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
---

A project that composes payments without the ledger can deploy its payments host. `@pithy-sh/payments` reached the ledger with `import("@pithy-sh/ledger/src/ledger")` inside a `try`, which is optional at runtime and required at bundle time: wrangler's esbuild resolves a literal specifier whether or not the branch holding it ever runs, so every such project failed with `Could not resolve "@pithy-sh/ledger/src/ledger"`. Payments now names the ledger nowhere. `ledger()` carries its surface as `ledgerPeer`, `payments()`'s `compose` hook finds it among the composed capabilities, and a catalog with a `grants.ledger` clause credits exactly as before. A composed ledger too old to carry the surface is refused at assembly. The ledger stays an optional peer.

Every other optional kit peer is reached the same way. Multiplayer finds the ledger and the leaderboard, matchmaking finds auth and rating, support finds auth and payments, and testers finds auth, each through its `compose` hook, off the `ledgerPeer`, `leaderboardPeer`, `authPeer`, `ratingPeer` and `paymentsPeer` those capabilities now carry. Organization recognizes email by shape rather than importing email's guard. A project without any of them bundles; one with them behaves as it did. A gate fails any shipped module that imports a kit package its package declares only as an optional peer.

A host Worker composes nothing, so the CLI hands it its peers. When a catalog credits a balance, the payments reconcile host is deployed from an entry `pithy` generates beside its config, importing the ledger from the project's own install. When a project composes auth, the testers host gets auth the same way. `pithy deploy --kit`, `pithy payments provision`, `pithy testers provision` and `pithy dev` all use it. Any other project deploys the host from its own `worker.ts`.

A host that deployed is no longer reported as not deployed. The reason beside a kit host's outcome described the account before the deploy, in the present tense: `acme-prod-email: deployed. acme-prod-email is not deployed.` It now reads `acme-prod-email: deployed. It was not on the account.`

A failed wrangler step prints wrangler's own error lines under the failure line, not only to its log file.
