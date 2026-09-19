---
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/organization": minor
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/support": minor
"@pithy-sh/testers": patch
---

A project that composes payments without the ledger can deploy its payments host. `@pithy-sh/payments` reached the ledger with `import("@pithy-sh/ledger/src/ledger")` inside a `try`, which is optional at runtime and required at bundle time: wrangler's esbuild resolves a literal specifier whether or not the branch holding it ever runs, so every such project failed with `Could not resolve "@pithy-sh/ledger/src/ledger"`. Payments now names the ledger nowhere. `ledger()` carries its surface as `ledgerPeer`, `payments()`'s `compose` hook finds it among the composed capabilities, and a catalog with a `grants.ledger` clause credits exactly as before. A composed ledger too old to carry the surface is refused at assembly. The ledger stays an optional peer.

Every other optional kit peer is reached the same way. Multiplayer finds the ledger and the leaderboard, matchmaking finds auth and rating, support finds auth and payments, and testers finds auth, each through its `compose` hook, off the `ledgerPeer`, `leaderboardPeer`, `authPeer`, `ratingPeer` and `paymentsPeer` those capabilities now carry. Organization recognizes email by shape rather than importing email's guard. A project without any of them bundles; one with them behaves as it did. A gate fails any shipped module that imports a kit package its package declares only as an optional peer: an `import`, an `export … from`, an `import()`, a `require()`, an `import x = require()`, an inline `type` specifier that `verbatimModuleSyntax` keeps, or a relative path into another package's source.

Nothing degrades silently. A capability a feature needs is expected in the same Worker unless the adopter turns the feature off. Where it is missing, assembly refuses and says what is missing, which feature needs it, and both remedies: compose it in this Worker, or turn the feature off with the named setting. Support and organization are minor releases for this. Both features are on by default, so a Worker that composes support without auth, or organization without email, must now compose it or turn the feature off.

- Multiplayer: a game with a `leaderboard` block needs `leaderboard()`. Off: remove the block. A game whose model moves balances, such as `craps`, needs `ledger()`. Off: remove the game. A game model declares it with `movesBalances`, and `wageringTable` sets it.
- Matchmaking: a game with a `skillPool` needs `rating()`. Off: remove the `skillPool`.
- Support: the in-app channel, on by default, needs `auth()`. Off: `submission: { enabled: false }`.
- Organization: invitation mail, on by default, needs `email()`. Off: `sendInvitationEmail: false`. It was refused at the first invitation.
- Payments: a product that credits a balance needs `ledger()`, as before. Off: remove its `grants.ledger` clause.

A composed auth, ledger, leaderboard, rating or payments released before its peer surface is refused beside any capability that reads it, with the upgrade to make. Read as absent, it cost testers every observation, support every sender link, and matchmaking every invite by address. The peer ranges rise to the releases that carry the surfaces.

`pithy testers list`, `status`, `roster` and `run` read tester activity through the project's composed auth. They passed none, so a project with auth read every tester unobservable, and `run` recorded a day of nobody observed. `readCohort` and the daily pass now require the argument, so a caller that leaves it out fails typecheck.

A host Worker composes nothing, so the CLI hands it its peers. When a catalog credits a balance, the payments reconcile host is deployed from an entry `pithy` generates beside its config, importing the ledger from the project's own install. When a project composes auth, the testers host gets auth the same way. `pithy deploy --kit`, `pithy payments provision`, `pithy testers provision` and `pithy dev` all use it. Any other project deploys the host from its own `worker.ts`. So does a host installed from a release older than this one, exactly as before, since it reaches its peers itself. A current host beside a peer too old to hand one over is refused by name.

A host that deployed is no longer reported as not deployed. The reason beside a kit host's outcome described the account before the deploy, in the present tense: `acme-prod-email: deployed. acme-prod-email is not deployed.` It now reads `acme-prod-email: deployed. It was not on the account.`

A failed wrangler step prints wrangler's own error lines under the failure line, not only to its log file.
