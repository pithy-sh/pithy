# @pithy-sh/organization

## 0.8.0

### Minor Changes

- [#809](https://github.com/pithy-sh/pithy/pull/809) [`4ea8960`](https://github.com/pithy-sh/pithy/commit/4ea8960e54418748aea3ac5864ec61c7573ce4a3) Thanks [@kingmesal](https://github.com/kingmesal)! - Suspend, reinstate or delete an organization, with the same window and restore a user gets. A member of other organizations keeps those: the suspended one simply stops being theirs.

- [#807](https://github.com/pithy-sh/pithy/pull/807) [`afe98cc`](https://github.com/pithy-sh/pithy/commit/afe98cc0686356fe7b5267cbc39ca452df0242b6) Thanks [@kingmesal](https://github.com/kingmesal)! - Administer a membership from the control plane: add or remove a member, change a role, force ownership when the owner is gone, fix an invitation, and hold a seat limit. Every one takes a reason and lands in the trail.

### Patch Changes

- Updated dependencies [[`b9d0453`](https://github.com/pithy-sh/pithy/commit/b9d0453e25c61d80eece0d8a08ac9d25c8bbadea), [`4ea8960`](https://github.com/pithy-sh/pithy/commit/4ea8960e54418748aea3ac5864ec61c7573ce4a3), [`afe98cc`](https://github.com/pithy-sh/pithy/commit/afe98cc0686356fe7b5267cbc39ca452df0242b6), [`b576f58`](https://github.com/pithy-sh/pithy/commit/b576f58fcda3962faeae75ec04ec37f8c1947f41)]:
  - @pithy-sh/auth@0.11.0
  - @pithy-sh/core@0.13.0
  - @pithy-sh/email@0.7.0

## 0.7.0

### Minor Changes

- [#803](https://github.com/pithy-sh/pithy/pull/803) [`fc57559`](https://github.com/pithy-sh/pithy/commit/fc5755924da66f7b01c818084d21ff91ae10602c) Thanks [@kingmesal](https://github.com/kingmesal)! - Mark a field `pii`, `phi`, `secret`, or `pci` and it can no longer reach a log, an audit record, or an error detail — the call stops compiling, and `redact` gives you the masked view instead. Declare your classes with `pithy privacy enable` and `console` closes, deploys refuse to ship past it, and your control plane reports exactly which schemas and fields hold what — derived from the running code, so unmarking a field is a change leadership can see. `pithy privacy scan` suggests what to mark. It never decides for you.

### Patch Changes

- Updated dependencies [[`69b84a8`](https://github.com/pithy-sh/pithy/commit/69b84a8d9b9016969ff317825e398a739fb525c3), [`2ec361e`](https://github.com/pithy-sh/pithy/commit/2ec361e9ab36d3f9a2907e0d5ca14d78914e3d3b), [`1b2b263`](https://github.com/pithy-sh/pithy/commit/1b2b2631fecd61533f1a668631131444de3700fc), [`fc57559`](https://github.com/pithy-sh/pithy/commit/fc5755924da66f7b01c818084d21ff91ae10602c)]:
  - @pithy-sh/auth@0.10.0
  - @pithy-sh/core@0.12.0
  - @pithy-sh/email@0.6.0

## 0.6.0

### Minor Changes

- [#770](https://github.com/pithy-sh/pithy/pull/770) [`dcb2d74`](https://github.com/pithy-sh/pithy/commit/dcb2d74b58a0ec7a6ca706b2608839d10d686862) Thanks [@kingmesal](https://github.com/kingmesal)! - Media assets and stored objects now carry an owner, an organization and a visibility — private, organization or public — so a file is seen only by the people it is meant for, private media is delivered through signed URLs, usage rolls up per user or per team, duplicate detection stays inside the tenant, and an erasure reaches a subject's files. **Breaking:** existing media records become private and system-owned; the `kv` media record store is removed; storage's `defaultVisibility` is now `visibility.default`, and a config still naming the old key is refused; and a public file read from outside its organization, or anonymously, no longer names its `ownerId`.
  
  Security: Four exposures, all live before this. Media's own routes checked only that a caller was signed in, so any user of an application could list, read and delete every other user's media in every organization, and every media delivery URL worked for anyone who held it. Duplicate detection was account-wide with no scope at all, so one tenant could ask whether another held a given file and a near-duplicate scan compared across every tenant's images. No read could be organization-scoped, so a per-user total summed across organizations and disclosed — by a figure that would not reconcile — that a user held an account in another organization. And nothing owned a media record, so a purge or a data-subject export could not enumerate a subject's files: an erasure would report success and leave them behind.

### Patch Changes

- [#793](https://github.com/pithy-sh/pithy/pull/793) [`b7877ad`](https://github.com/pithy-sh/pithy/commit/b7877ad4ea39c579f775c53a77b08b3c333c5594) Thanks [@kingmesal](https://github.com/kingmesal)! - Sign-in works again on the Better Auth a fresh install resolves, and the kit now requires Better Auth 1.7.11, past a critical account-takeover fix. A new migration relaxes the account `issuer` column that Better Auth 1.7.3 stopped writing. Magic Links and OAuth sign-ins started before the upgrade must be restarted. A social sign-in that fails to attach the provider to an existing account now redirects with `provider_sign_in_refused`, like the other refusals the user table decides.
  
  Security: The kit's `better-auth` range admitted versions with GHSA-965c-763c-88jm, a critical flaw that let anyone who knew a user's email sign in as them through Magic Link on any deployment with a social provider configured. Separately, `unable_to_link_account` reached the browser on the social callback only when an account already existed at the address, so a failed account write answered the same question the collapsed codes do. It is collapsed now.
- Updated dependencies [[`27d8d53`](https://github.com/pithy-sh/pithy/commit/27d8d5376b755f91496df325815f3239716e4de7), [`68bc375`](https://github.com/pithy-sh/pithy/commit/68bc3754d340acfd495fb8bd28466c27fd5ed1ba), [`b7877ad`](https://github.com/pithy-sh/pithy/commit/b7877ad4ea39c579f775c53a77b08b3c333c5594), [`5a8fc16`](https://github.com/pithy-sh/pithy/commit/5a8fc166fdfdc0c8a7b157a9b7f76fab2fcee7e6), [`e7f84b3`](https://github.com/pithy-sh/pithy/commit/e7f84b35d35c2cab5fbd9429e23bbf9ca6fd3bf7), [`dcb2d74`](https://github.com/pithy-sh/pithy/commit/dcb2d74b58a0ec7a6ca706b2608839d10d686862), [`f0a13c6`](https://github.com/pithy-sh/pithy/commit/f0a13c65956bf8f58e91c7751362bbcd5c57db04), [`6978c6d`](https://github.com/pithy-sh/pithy/commit/6978c6d10dc231a6f0b9fe114902433bc209f031), [`8b9c185`](https://github.com/pithy-sh/pithy/commit/8b9c185a6a9ca6f4a0cbfcdb89632cd0091fc65e), [`1c9c17d`](https://github.com/pithy-sh/pithy/commit/1c9c17d41cb1661cb86b5ad392bad70f5d786caf), [`fc5ccac`](https://github.com/pithy-sh/pithy/commit/fc5ccac1e8d19689216c8b97db9624bd0e5b6203), [`ae158a1`](https://github.com/pithy-sh/pithy/commit/ae158a1e3103577de9f9e3fb55d7727b4851ef54), [`61a99b9`](https://github.com/pithy-sh/pithy/commit/61a99b9457abaf150a4b0603b1ce597d1a72f489), [`e75c46c`](https://github.com/pithy-sh/pithy/commit/e75c46c5cea94b8f9175a68b5027324ba89a8155), [`1f6517f`](https://github.com/pithy-sh/pithy/commit/1f6517f82c431a61edbe05c46ebb2397fd529dd6), [`1fd60e4`](https://github.com/pithy-sh/pithy/commit/1fd60e43b8dc6947e1e12551981924725894f303), [`30c0c5a`](https://github.com/pithy-sh/pithy/commit/30c0c5ab52e89c535f4dd92d64a66320850480b8), [`e79ccba`](https://github.com/pithy-sh/pithy/commit/e79ccbab8a85dc3b51d0ffd13a082563aa548c9b)]:
  - @pithy-sh/core@0.11.0
  - @pithy-sh/auth@0.9.0
  - @pithy-sh/email@0.5.0

## 0.5.0

### Minor Changes

- [#740](https://github.com/pithy-sh/pithy/pull/740) [`2a4e096`](https://github.com/pithy-sh/pithy/commit/2a4e0960fc4d6417f12de30a6b8fe6b7920d16c7) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy can be built on by an agent team. `/plugin install pithy@pithy` adds one to Claude Code, a server, a web client, a mobile client and a runner, each on the model you choose, and when it finds something the kit cannot do, it files the issue. Every route now has a published OpenAPI contract, so a client in any language calls Pithy the same way.

### Patch Changes

- [#716](https://github.com/pithy-sh/pithy/pull/716) [`add483b`](https://github.com/pithy-sh/pithy/commit/add483bca549b18ff370f69c7b4308e4fd725727) Thanks [@kingmesal](https://github.com/kingmesal)! - Every command an error or a report names now runs as written, and every `provision --json` ends in one outcome.
  
  One builder, checked against the CLI's own command catalog, spells every `pithy` command an error, a report or a `fix` names: it names the Worker by its `apps/` directory, carries `--with-prerequisites` and the `--set` an option with no default needs, keeps the flags and values a rerun was given — `--json` included, and a caller's value shell-quoted exactly as it was passed, never refused as a placeholder — and never hands over a destructive or production command as a `fix` — that is said as a person's decision instead. A project with no Worker is told to create one first rather than handed a `pithy add` it would refuse.
  
  `pithy secrets provision` provisions every environment, production included, so it is never a `fix` either. `pithy doctor --json` gives `secretBindings.missing[].fix` as `null` for a value the kit composes, and `provision --json` carries `pendingSecretsRemedy` as that decision rather than as a command to run.
  
  `email`, `media`, `payments`, `storage`, `support` and `testers` `provision --json` now end in one outcome. A run that provisioned no environment writes only its error line, on stderr, and exits 3. Stdout is empty, where it used to carry a report. A run that went ahead writes only its report, and the report now carries `exitCode`. A script that read the report after an all-skipped run reads the error line instead.
- Updated dependencies [[`831e3f4`](https://github.com/pithy-sh/pithy/commit/831e3f4cf5e336094bf8f24ef74506bfda5f0282), [`2bcc71a`](https://github.com/pithy-sh/pithy/commit/2bcc71a229e96536a734e9db12ea901d58abbbc4), [`2a4e096`](https://github.com/pithy-sh/pithy/commit/2a4e0960fc4d6417f12de30a6b8fe6b7920d16c7), [`63dab50`](https://github.com/pithy-sh/pithy/commit/63dab50808d8a18a75bc281e4867e3c78b446bfb), [`c91dfae`](https://github.com/pithy-sh/pithy/commit/c91dfae2a3674835e5f222ac34f32d8976371fef), [`add483b`](https://github.com/pithy-sh/pithy/commit/add483bca549b18ff370f69c7b4308e4fd725727), [`c9606a3`](https://github.com/pithy-sh/pithy/commit/c9606a3bfbc2924a2530470e6676547ffabd8669)]:
  - @pithy-sh/core@0.10.0
  - @pithy-sh/auth@0.8.0
  - @pithy-sh/email@0.4.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`5a9588d`](https://github.com/pithy-sh/pithy/commit/5a9588db35a3c9bcb023f0065cec268238794f9a), [`53b2ec9`](https://github.com/pithy-sh/pithy/commit/53b2ec9cd66f7c54d7d3df82d18c9d41d6cb70f1)]:
  - @pithy-sh/core@0.9.0
  - @pithy-sh/auth@0.7.0
  - @pithy-sh/email@0.3.11

## 0.4.1

### Patch Changes

- Updated dependencies [[`b9c624f`](https://github.com/pithy-sh/pithy/commit/b9c624fa227f23dbc97545a03544ef1af5bba182)]:
  - @pithy-sh/core@0.8.0
  - @pithy-sh/auth@0.6.7
  - @pithy-sh/email@0.3.10

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
