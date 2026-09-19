# @pithy-sh/organization

## 0.4.0

### Minor Changes

- [#646](https://github.com/pithy-sh/pithy/pull/646) [`f730971`](https://github.com/pithy-sh/pithy/commit/f7309714305292d57244b93a33487e5f776c29d5) Thanks [@kingmesal](https://github.com/kingmesal)! - A project that composes payments without the ledger can deploy its payments host. `@pithy-sh/payments` reached the ledger with `import("@pithy-sh/ledger/src/ledger")` inside a `try`, which is optional at runtime and required at bundle time: wrangler's esbuild resolves a literal specifier whether or not the branch holding it ever runs, so every such project failed with `Could not resolve "@pithy-sh/ledger/src/ledger"`. Payments now names the ledger nowhere. `ledger()` carries its surface as `ledgerPeer`, `payments()`'s `compose` hook finds it among the composed capabilities, and a catalog with a `grants.ledger` clause credits exactly as before. A composed ledger too old to carry the surface is refused at assembly. The ledger stays an optional peer.
  
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

### Patch Changes

- Updated dependencies [[`f730971`](https://github.com/pithy-sh/pithy/commit/f7309714305292d57244b93a33487e5f776c29d5)]:
  - @pithy-sh/auth@0.6.4

## 0.3.1

### Patch Changes

- [#629](https://github.com/pithy-sh/pithy/pull/629) [`0af7119`](https://github.com/pithy-sh/pithy/commit/0af7119842e77db3cf3b45bb982660e502b86313) Thanks [@kingmesal](https://github.com/kingmesal)! - Every capability reports the package that supplies it, beside the version it already reported. `GET /control-plane/manifest` carried a version per capability and no package name, and a version is only actionable joined against a release feed keyed by package — so a client had to derive one from the capability's name. `@pithy-sh/<name>` is right for most capabilities and wrong for the one that matters: the seam is named `controlplane` and ships inside `@pithy-sh/core`, so the guess asked about a package that has never been published, the join came back empty, and empty is indistinguishable from *up to date* for the most frequently released package in the feed. Each capability now sets `package` from its own generated `PACKAGE_NAME`, stamped from its own `package.json` — never derived from `name` by the framework, because a capability name and a package name are different kinds of thing and one package may ship more than one capability. `package` and `version` are null together, which is the adopter's own `app` capability: a name, no package, no version. The field is optional on the wire, so a manifest produced by a Worker deployed before this parses whole and reads as null, and a client falls back to whatever it guessed before rather than losing every pane over one key. A repo-wide gate enumerates the capability packages from the source tree and fails when one declares a package that is not its own `package.json` name, or reads the constant from a sibling. That second half asks where the import lands — it resolves the specifier against the capability's own directory and requires the result to be that package's `src/version.generated` — rather than matching the spellings a well-behaved import has. Matching shape cannot hold this claim: `.` is an ordinary character in a directory name, so a `..` segment is indistinguishable from a descent, and `../../core/src/version.generated` satisfies every pattern written to exclude exactly it.
- Updated dependencies [[`11456e4`](https://github.com/pithy-sh/pithy/commit/11456e4004283ab5b2ee266bce2ee7520631d960), [`0af7119`](https://github.com/pithy-sh/pithy/commit/0af7119842e77db3cf3b45bb982660e502b86313), [`6a12e7b`](https://github.com/pithy-sh/pithy/commit/6a12e7b761f29f4a8113eebfdc062b1dbb8e8a6b)]:
  - @pithy-sh/auth@0.6.3
  - @pithy-sh/core@0.7.3
  - @pithy-sh/email@0.3.7

## 0.3.0

### Minor Changes

- [#610](https://github.com/pithy-sh/pithy/pull/610) [`2463acf`](https://github.com/pithy-sh/pithy/commit/2463acf1aa5f8daed37cfbc378fce9edd77afe69) Thanks [@kingmesal](https://github.com/kingmesal)! - A short name is derived from the name, not demanded from the caller.
  
  `POST {base}` required a `slug`, so every client had to invent one and the server took whatever it was given. It is optional now. Omitted, the server derives it from the display name and the unique constraint settles it: a collision retries with a suffix rather than asking first, because a check-then-write has a window and the migration says so at the column. A supplied `slug` behaves exactly as it always has — held to the column's rule, and a collision refuses rather than renaming.
  
  Derivation folds what folds. `Café Ñandú` is `cafe-nandu`, and `Ærø` is `aero` through a short table of the Latin letters Unicode does not decompose. A name with no Latin letters in it — Chinese, Russian, Greek, Arabic, Hebrew, Thai — gets a stable token derived from that name, distinct per name. The version this replaces reduced every one of those to one base, and a shared base can be exhausted.
  
  New setting, `slugs: "chosen" | "derived"`, default `"chosen"` — today's behavior, so nothing changes for a project that does not set it. `"derived"` refuses a supplied `slug` on the route line, naming the field, for a product where no URL contains one. The audit fact for a founding carries `derived` beside the slug, so the trail says whether a caller picked it.
  
  The manifest declares the setting's two values, so `pithy add organization` offers them as a choice and `--set slugs=derivd` is refused instead of written into the config.

### Patch Changes

- Updated dependencies [[`2463acf`](https://github.com/pithy-sh/pithy/commit/2463acf1aa5f8daed37cfbc378fce9edd77afe69)]:
  - @pithy-sh/email@0.3.6
  - @pithy-sh/auth@0.6.2

## 0.2.2

### Patch Changes

- Updated dependencies [[`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`db6674a`](https://github.com/pithy-sh/pithy/commit/db6674a775fc14c4e20410352bdd90c1c54abed8), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`db6674a`](https://github.com/pithy-sh/pithy/commit/db6674a775fc14c4e20410352bdd90c1c54abed8), [`db6674a`](https://github.com/pithy-sh/pithy/commit/db6674a775fc14c4e20410352bdd90c1c54abed8), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`d7a7168`](https://github.com/pithy-sh/pithy/commit/d7a7168e2ce7d2769d220e39d55e095a4477a31f), [`32186ff`](https://github.com/pithy-sh/pithy/commit/32186ff9efe385665496f1ecafe315f4e248ae3a)]:
  - @pithy-sh/core@0.7.0
  - @pithy-sh/email@0.3.4
  - @pithy-sh/auth@0.6.2

## 0.2.1

### Patch Changes

- [#576](https://github.com/pithy-sh/pithy/pull/576) [`7d9a7c4`](https://github.com/pithy-sh/pithy/commit/7d9a7c48e26dffd9d1062af0b743049b967e78e1) Thanks [@kingmesal](https://github.com/kingmesal)! - A release now publishes what it built.
  
  `release:local` never ran a build. It versioned the packages and published whatever `dist/` was lying in the checkout, so the 2026-09-14 release put twenty-two packages of weeks-old compiled code on npm under fresh version numbers — and `@pithy-sh/organization`, never built in that checkout at all, with no `dist/` and every deep import resolving to nothing.
  
  This is those twenty-two, republished from a build. Nothing in the source changed; the artifact did.
  
  The release builds now, after the bump and before the publish, and packs every tarball through the gate CI already ran. `packFaults` gains the one question a tarball can answer about how old its build is: the version compiled into `dist/version.generated.js` must be the version being published.
- Updated dependencies [[`7d9a7c4`](https://github.com/pithy-sh/pithy/commit/7d9a7c48e26dffd9d1062af0b743049b967e78e1)]:
  - @pithy-sh/auth@0.6.1
  - @pithy-sh/core@0.6.1
  - @pithy-sh/email@0.3.3

## 0.2.0

### Minor Changes

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - An invitation email links to your app, not to this capability's JSON.
  
  `invitationAcceptUrl` built the link from `basePath` — the prefix every route here mounts under — and `GET {basePath}/invitations/:token` answers `c.json(...)`. So every invitation this capability has ever sent pointed a person at a response body in their browser. Not a page, not an actionable error: the offer rendered as JSON.
  
  No composition could avoid it. Aiming `basePath` at a page path does not help, because the JSON route mounts there too and the Worker answers before any client router sees the request.
  
  `invitationAcceptPath` is now a setting of its own, `/invitations` by default, and the mail is built from it. The page you serve at `/invitations/:token` reads `GET {base}/invitations/:token` for the offer and posts the token to `POST {base}/invitations/accept` to redeem it — both unchanged.
  
  **If you have already composed this capability**, check where your app serves that page. The default matches the conventional path; a project that mounted its acceptance screen elsewhere should set `invitationAcceptPath` to match, and pick it before inviting anybody, because changing it breaks the link in mail already sent.
  
  `INVITATION_ACCEPT_SEGMENT` is renamed to `INVITATIONS_ROUTE_SEGMENT`. It names the JSON routes' segment inside `basePath` and no longer has anything to do with the accept link, and a constant still called *accept* would point the next reader at exactly the conflation this fixes.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Tenancy, out of the box.
  
  Organizations, memberships, roles you define with the powers they hold, invitations bound to an address, ownership that moves only when somebody accepts it, and an acting selection proved against a live membership on every request. The model the Pithy dashboard itself runs on.
  
  **You declare the roles**, because a coaching academy's `coach` and `student` are parallel where a dashboard's `owner`, `admin` and `member` nest — and a capability that assumed either shape would refuse the other. Nesting is asserted only where you claim it. Five power names are the kit's, because it ships the routes that gate on them; yours sit beside them under your own vocabulary, and your handlers import them as typed values rather than reading strings out of a config file. `pithy add organization` scaffolds the catalog and never overwrites one.
  
  `administrativePower` is named rather than inferred from a role spelled `admin`, so an account with one owner and one admin does not become unadministrable when the admin leaves. Assignability is derived by exclusion, so a role you add is assignable by default and excluding it is the deliberate act.
  
  **What a membership is worth is what makes the refusals load-bearing.** A caller naming an organization they do not belong to gets a 404 byte-identical to the one for an organization that does not exist, because a distinguishable refusal is an existence oracle and iterating it produces your customer list. A role is decoded off the row and refused when the catalog does not know it, never asserted against a matrix that would deny everything today and allow it after one refactor. Nothing about a role rides on the session — only the id of the chosen organization — so removing a membership row is the whole of revocation and takes effect on the next request with no sign-out.
  
  The acting membership lands on its own context variable rather than on the auth one, because "signed in" and "a member of this organization" are two conditions and merging them makes them one. Composing this alongside Better Auth's `organization()` plugin is refused at boot, and `docs/why-not-better-auth-organization.md` is the record of why this model rather than that one — checked against `better-auth@1.7.1` line by line, including where the comparison has been stated wrongly before.
  
  `@pithy-sh/core` gains a manifest-level `seams` field, for a capability that needs a scaffolded module under every configuration rather than under one choice of one option.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Deleting an organization now deletes your rows too, if you say which.
  
  `deleteOrganization` swept its own five tables and stopped. Every adopter who composes this capability has tables keyed on `organizationId` — that is what tenancy is — and it cannot see them, so their rows stayed behind for an account that no longer existed. Where those rows hold a credential, the act everybody believes revoked it did not.
  
  `organization({ onDelete })` takes a function returning statements, and they join the same `d1.batch`, ahead of this capability's own. **Statements rather than work**, because that is what puts them in the transaction: a failure anywhere rolls all of it back, so the account and your rows end together or neither does. A callback that deleted for itself could not be in that batch, and what it leaves behind on a bad day is the bug.
  
  They run before the memberships go, so one may still resolve something through a membership.
  
  A composition without `onDelete` behaves exactly as before.

### Patch Changes

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - A session ending now takes the acting selection with it.
  
  `clearActing` existed, was exported, and **nothing called it** — so the acting selection outlived the credential that made it, one orphan row per sign-in, in a table with no TTL and no sweep. The capability's own schema says "signing out must take it with it"; there was no moment at which it could.
  
  Nothing in `@pithy-sh/organization` can see a sign-out, and the dependency runs the wrong way to fix that there. So `@pithy-sh/auth` grows an `onSessionRevoked` seam, and the project composing both joins them:
  
  ```ts
  auth({
    onSessionRevoked: async ({ id }, d1) => {
      await clearActing(organizationDatabase(d1), { sessionId: id });
    },
  }),
  ```
  
  **On the row, not on the sign-out route.** A sign-out, a revoke and an admin ending somebody's devices all delete the same row, so a listener hung off one endpoint would miss the others. It is handed this request's D1 binding because the auth instance is built per request, and it swallows what it throws — the session is already gone, and a listener's failure must not turn a completed sign-out into an error the caller retries.
  
  Composing `@pithy-sh/auth` without a listener is unchanged and requires nothing.
  
  The orphan row never conferred anything — every read re-joins memberships and matches the user id too — so this is growth rather than an access question.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Inviting an address that already holds an offer is one transaction, not two statements.
  
  `invite()` canceled the standing offer and inserted the new one in two separate awaits. Two concurrent invitations to one mailbox — a double-clicked Send, a retried POST — both found nothing to supersede and both inserted. The partial unique index underneath refused the second, so the table stayed correct, but the caller that lost got a raw constraint violation: a 500 on an ordinary action.
  
  Both statements now go into one `d1.batch`, which D1 runs as a transaction, the same way `acceptInvitation` already did and for the same reason. The later of two concurrent invites supersedes the earlier and both callers get the offer they asked for. The index stays underneath as the backstop for a writer that never came through here.
  
  Two migrations also now drop every index they create, matching the fourteen that already did — `@pithy-sh/organization` created six and dropped none, `@pithy-sh/secrets` created one and dropped none. SQLite takes an index with its table, so this changes nothing at runtime; what it changes is that a `down` reads as the inverse of its `up` in every capability, and a new test across the whole tree fails when one stops.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Three migrations said D1 does not enforce foreign keys. It does.
  
  `PRAGMA foreign_keys` is on, a cascade fires, and an orphan insert is refused with `FOREIGN KEY constraint failed` — measured against a real binding in two separately configured pools, and now pinned by a test in `@pithy-sh/core` that checks both directions.
  
  The convention those docblocks describe is unchanged and still right: no foreign key crosses a capability boundary, because a constraint from one capability's table to another's binds two release cadences together and breaks the day either moves to its own database. What changes is the reason given for it. A false reason is worse than none, because it ends the conversation — and it was ending it on the platform rather than on the boundary, which is where the real trade is.
  
  Nothing about any schema moves. Within a single capability's own tables a foreign key is available and is still not used; that is worth revisiting per table rather than as a rule.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Volunteering for an ownerless account now takes standing over it.
  
  **Security: a member of any account that had never transferred ownership could make themselves its owner, in two requests, irreversibly.** `nominate()` allowed a self-nomination whenever nobody held the account and checked nothing else, and the route that reaches it carries membership and no power — deliberately, because the obvious `billing:manage` gate demands the owner the account does not yet have.
  
  The reachability is the part worth stating: `founderRole` gives a founder the first *assignable* administering role and the conferred role is unassignable by definition, so **every account is ownerless from the moment it is founded** and stays so until somebody completes a transfer. So "anybody in it may volunteer" meant any member of almost every account — and since a transferable role must administer, that self-transfer took a reader holding `organization:read` to `members:manage`, `billing:manage` and `organization:delete`. Nothing undid it: the conferred role is unassignable, so demote, remove and leave all refuse it.
  
  A volunteer must now already administer the account. That closes it without closing the account, because `founderRole` is defined as an administering role — a fresh account always has somebody who can take it on. The rule lives in `nominate()` rather than as route middleware, so an adopter calling the store directly gets it too.
  
  Three other defects found in the same pass:
  
  - `acceptNomination` dereferenced `withD1Retry`'s result without checking it. That wrapper returns `undefined` when a unique-constraint failure lands on a retry, so a transient fault could surface as a `TypeError` and a 500 rather than the refusal the code intends.
  - `acceptInvitation` reported an invitation as accepted while its row was still `pending`. `d1.batch` is a transaction, so the membership collision that reaches the fallback rolls the status update back with it — leaving a live redeemable token, an offer still listed as outstanding, and an audit row saying otherwise. The offer is now consumed on that path, which is what the module already documented.
  - `catalog.powersOf`, `roleAllows` and `administers` threw a `TypeError` for a role named `toString`, `constructor` or `valueOf` — the lookup reached `Object.prototype`, so `?? []` never fired. They deny now, which is what their own comment claimed. Unreachable from inside this package, which decodes every role through `Role` first, and reachable from an adopter's own handler, which is the advertised use.
  
  And in `@pithy-sh/auth`, `sanitizeProfile` let a `name` that was not a string through untouched, so a provider sending a number or an object at sign-up reached the column. It is replaced now, as an over-long one already was.
- Updated dependencies [[`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`afc4235`](https://github.com/pithy-sh/pithy/commit/afc4235968d9d6b31470a356da1a95936a6fe98c), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2)]:
  - @pithy-sh/core@0.6.0
  - @pithy-sh/auth@0.6.0
  - @pithy-sh/email@0.3.2
