# @pithy-sh/core

## 0.1.3

### Patch Changes

- [`9579441`](https://github.com/pithy-sh/pithy/commit/9579441c0cd49bb690f21451a8ec07460e1220d9) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add` no longer crashes on the manifest `pithy init` wrote.
  
  It crashed for any adopter whose resolver landed below zod 4.4.0, and for nobody else — the second command of the standard first run, on a file the first command had just written. Below that version `z.record`'s key check enumerates symbol keys, and comment-json hangs a document's comments off exactly those, so a manifest was refused for having comments in it. Bisected: 4.0.0 through 4.3.6 fail, 4.4.0 onward pass.
  
  **The defect was the range, not the code.** Every package declared `zod: ^4.0.0` while depending on behavior that arrives in 4.4.0 — a promise about every version in the range that only some of them keep. The floor is now `^4.4.0`, and `manifests.test.ts` holds it there with the reason attached.
  
  Nothing loosens `z.record`'s key check. Symbols are preserved deliberately so an adopter's comments round-trip ([#222](https://github.com/pithy-sh/pithy/issues/222)), and the schema already validates by delegation to keep that true.
  
  The reporter is fixed too, separately. `whereItBroke` joined an issue path with `Array.prototype.join`, which throws on a symbol — so it threw while reporting, and the adopter got a `TypeError` from an unrelated file instead of a word about theirs. It stringifies each segment now. Nothing in the kit produces such a path any more; a function whose job is to name where something broke still must not be able to break.

- [#479](https://github.com/pithy-sh/pithy/pull/479) [`24d3245`](https://github.com/pithy-sh/pithy/commit/24d32459145ccedd8b2c3b6cf715646acdfdabaa) Thanks [@kingmesal](https://github.com/kingmesal)! - Every package now ships JavaScript with declarations beside it, so node can import the kit.
  
  `exports` pointed at `./src/*.ts`. That works for every consumer with a bundler — wrangler, Vite, vitest transforming a test — and fails for the one with none: node, which refuses to strip types under `node_modules` and cannot be argued out of it. An adopter's `vitest.config.ts` importing `@pithy-sh/vite` died there with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and so would any Node script that touched the kit.
  
  Each package builds with tsdown for the JavaScript and `tsc --emitDeclarationOnly` for the types. Two tools because each does one half well: tsdown resolves relative imports to real extensions and leaves siblings external, so `core` is not copied into the twenty packages that depend on it, while its own declaration bundling would flatten `src/error/pithyError.ts` to `dist/pithyError.d.ts` and break the `./src/*` deep-import surface. `tsc` mirrors the tree exactly, so `@pithy-sh/core/src/error/pithyError` keeps resolving to the same path it always named.
  
  **The import path an adopter writes has not changed.** `exports` still keys on `./src/*`; it resolves onto `./dist/*.js` and `./dist/*.d.ts` now instead of onto the TypeScript. Source still ships, because the declaration and source maps point back into it — stepping into the kit lands on the file it was written in.
  
  Two gates were added rather than assumed. `bun run clean-room` imports the packed kit with plain `node` and requires a declaration beside each module; pointing one package's `exports` back at raw TypeScript fails it with the original error. And `bun run verify-published` refuses a tarball that carries no build, or a published module with one half of its pair — a `.js` with no `.d.ts` is an `any` in the adopter's editor, and a `.d.ts` with no `.js` is a type that cannot be imported.

- [#484](https://github.com/pithy-sh/pithy/pull/484) [`800abda`](https://github.com/pithy-sh/pithy/commit/800abdaae3ef4b584c3b0060642d49ebd098fa67) Thanks [@kingmesal](https://github.com/kingmesal)! - `zod`, `kysely` and `hono` are peer dependencies now, so you and the kit share one copy.
  
  They were plain dependencies, which meant an adopter who imports them directly — and anyone writing their own schemas or queries does — could end up with a second copy. Two copies of a package whose classes carry private members are two different types, and the compiler says so in a way that names neither the package nor the duplication:
  
  ```
  Type 'Kysely<any>' is not assignable to type 'Kysely<any>'.
    Property '#private' refers to a different member that cannot be accessed from within type.
  ```
  
  Both paths read identically unless you compare them character by character. A dependency is the kit saying "I need some copy of this"; a peer dependency is the kit saying "you and I must share one", which is the true statement and the one npm, pnpm and bun all act on by installing it once, at the top, where your own import finds it too.
  
  **Nothing to do in most projects.** Your installer resolves the peer on the next install. If you already declare these, check the range matches — `zod@^4.4.0`, `kysely@^0.29.0`, `hono@^4.13.2`.
  
  `@hono/zod-validator` and `kysely-d1` are deliberately not peers: their types do not cross the published boundary, and each depends on `hono` and `kysely` itself, so the copy that matters is already the shared one.
  
  **`pithy doctor` reports a duplicate now**, with the directories each copy was resolved from, because the symptom is otherwise unreadable. It resolves rather than scanning, so what it answers is whether the kit and your code agree on which copy — and it never fails the exit, since a second copy can be deliberate.

- [#485](https://github.com/pithy-sh/pithy/pull/485) [`c8e45ba`](https://github.com/pithy-sh/pithy/commit/c8e45baeac30231559ba53dba4b7b9a4a10cd46a) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` declares the capability on the Worker that composes it, and refuses a choice it cannot write.
  
  **A capability now lands in `apps/<worker>/package.json`.** The import goes into that Worker's `pithy.config.ts`, so that is what depends on it — which is where `pithy init` already puts `@pithy-sh/core` and where `pithy ui add` already writes. Declared only at the root, it resolved by hoisting, and under a package manager that does not hoist it was not linked beside the Worker at all: a fresh sequence of adds failed part-way and then succeeded on a retry, because the failed run left the package on disk. A first-day failure nobody could reproduce afterwards. The install still runs at the root, where the lockfile is; only the declaration moved, at the range the root resolved.
  
  It also makes the Worker's manifest true. The composed config is per-Worker by design — two Workers are meant to compose different sets — and one shared root dependency list cannot say what either is made of.
  
  **`pithy add payments --set billingSubject=organization` is refused rather than written.** That mode needs a `resolveSubject` seam saying which organization a caller is acting for; the capability refuses to assemble without one, deliberately, because a capability that guessed would key a company's plan to whoever signed in first. `pithy add` renders JSON and cannot render a function, so it was writing the one composition the kit is designed to reject — and since every command begins by loading the config, the add bricked the project. It now stops at the flag and names the two steps.
  
  Capabilities can declare this themselves: a manifest's `configOptions[].choicesNeedingCode` maps a choice to the sentence explaining what to do instead.

- [#488](https://github.com/pithy-sh/pithy/pull/488) [`8ed1f95`](https://github.com/pithy-sh/pithy/commit/8ed1f958925f6987a1cc357225631b56221d5621) Thanks [@kingmesal](https://github.com/kingmesal)! - A refusal never offers a value the next refusal rejects.
  
  Making `billingSubject=organization` unwritable left the message telling you what to pass still naming it: `pithy add payments --json` answered `Pass --set billingSubject=user or --set billingSubject=organization`, and passing the second was refused. The interactive prompt had the same gap, offering it in the select.
  
  Both now offer only what composes. The prompt withholds such a choice rather than listing something unselectable, and says what it would take — `organization` is the mode a B2B project is looking for, and a list that simply lacks it reads as "unsupported" instead of "needs one line you have to write".
  
  The rule, written down in `docs/commands/add.md`: **a scaffolded stub is right when the missing value is data, and a refusal is right when it is behavior.** `pithy add secrets` writes an empty registry with a comment, because an empty registry is a valid state you fill in; there is no equivalent for `resolveSubject`, because a resolver returning nothing loads and then silently denies every entitlement gate.

## 0.1.2

### Patch Changes

- [`b8673f3`](https://github.com/pithy-sh/pithy/commit/b8673f3a08377ecaff9f43aad600d6aae0660ef4) Thanks [@kingmesal](https://github.com/kingmesal)! - Every package installs from npm. Twenty of them did not.
  
  `0.1.0` and `0.1.1` published their dependencies on sibling packages as `workspace:*`. That is a Bun, pnpm and yarn convention, and **npm does not implement it** — measured both ways, `npm pack` leaves it verbatim from the package directory and from the repository root with `-w`. Changesets publishes through `npm publish`, so the range reached the registry unrewritten and no resolver could do anything with it. `bun add @pithy-sh/cli` failed before installing anything. Only `core` and `ui-react` worked, because they depend on no sibling.
  
  Internal dependencies now carry a concrete range, which Changesets already maintains across releases, and which still resolves to the workspace locally — a package's siblings link exactly as before.
  
  **Nothing in this repository could have caught it.** Every test here runs inside the workspace, where `workspace:*` resolves perfectly; the range is only wrong once it leaves. So the check moved to where the evidence is: `verify-published` now extracts the manifest from a real tarball rather than reading the one on disk, and fails on a workspace range in anything a consumer installs. A devDependency keeps it, because a consumer never installs one.

## 0.1.1

### Patch Changes

- [`dfda7b2`](https://github.com/pithy-sh/pithy/commit/dfda7b25c897f3fe30ad7d498dde1216a25edc09) Thanks [@kingmesal](https://github.com/kingmesal)! - Released from CI, with provenance.
  
  Every package's first release was cut from a laptop, and a laptop has no OIDC identity to attest with — so `0.1.0` carries no provenance. This one is built and published by the release workflow over npm trusted publishing, so `npm audit signatures` can verify each tarball came from this repository, from `main`, from the workflow that claims it.
  
  No code changed. The difference is what an adopter can prove about what they installed.

## 0.1.0

### Minor Changes

- [#133](https://github.com/pithy-sh/pithy/pull/133) [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64) Thanks [@kingmesal](https://github.com/kingmesal)! - Give `signed-webhook` an implementation any sender can be verified with.
  
  `signed-webhook` has been a first-class verification strategy since the contract landed, but the only code behind it was the payments webhook guard — welded to a rail catalog, a D1 table and a dedup insert. An adopter declaring the strategy on their own route had the word and nothing to put behind it.
  
  `requireSignedWebhook` from `@pithy-sh/core/src/http/signedWebhook` is that implementation: `<header>: t=…,v1=…`, one hex HMAC-SHA256 per signature over `<timestamp>.<body>`. Stripe's format, because it is the one every other sender copied. The timestamp is inside the signed payload, so re-dating a captured delivery invalidates its own signature; the freshness window is checked in both directions; the comparison is `crypto.subtle.verify`, never `===`; every listed signature is tried, up to a cap, so a rotation on either side keeps verifying without buying an anonymous caller unbounded HMAC work. A refusal is `core/webhook_unverified` (401) with the failing step in `detail`, which the HTTP codec strips.
  
  Dedup stays the caller's. This proves a delivery is authentic and fresh, never that it is new — a handler that grants or charges needs its own uniqueness key.
  
  Payments' Stripe rail now composes the primitive through `checkSignedWebhook`, which reports rather than throws, and keeps `payments/verification_failed` and its own wording. The verifier no longer exists twice.

- [#133](https://github.com/pithy-sh/pithy/pull/133) [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64) Thanks [@kingmesal](https://github.com/kingmesal)! - Open the error taxonomy, and give it a word for someone else's outage.
  
  `core/upstream_failed` (502) and `core/upstream_timeout` (504) name a dependency this service does not control — the case a proxy or a control plane hits constantly, and until now had to report as `core/internal`, a 500 that blames the wrong system. `UpstreamError` and `UpstreamTimeoutError` throw them.
  
  `ErrorPayload` is no longer closed. It is the kit's union plus one open member, so an adopter can throw `connect/device_code_expired` or `keys/rotation_locked` under their own domain through `defineErrorPayload`. The kit's own set stays closed as `KitErrorPayload` / `KitErrorCode` — switch exhaustively over that, never over `ErrorCode`.
  
  The kit's domains are reserved, like its table prefix: `auth/`, `payments/`, `core/` and the rest are refused — at the declaration, as a type error, and again at the parse. So a capability's typo stays a hard failure and the kit can add codes under its own domains without landing on an adopter's. And the HTTP codec strips `detail` from an adopter's error exactly as it does from the kit's. That boundary does not move.
  
  Narrow with `isErrorCode(payload, "connect/device_code_expired")`, and type a vehicle class with `ErrorPayloadOf<"connect/device_code_expired">`. An adopter's code is branded — that brand is what keeps `payload.code === "core/not_found"` narrowing to exactly one kit member — and the cost is that a bare `===` against an adopter's own literal does not compile. These two are the way in for both halves.
  
  **Two type changes to expect on upgrade.** `ErrorPayload` and `PublicErrorPayload` are a `z.union`, not a `z.discriminatedUnion`, so anything holding them as the latter moves to `KitErrorPayload`. And `payload.status` widens from a literal union to `number`, because an adopter's status is bounded (400–599) rather than pinned: code passing it straight to Hono — `c.json(body, err.payload.status)` — now wants `as ContentfulStatusCode`, which is what `pithyErrorHandler` does internally. Anyone on `pithyErrorHandler` is unaffected.

- [#140](https://github.com/pithy-sh/pithy/pull/140) [`bd6b339`](https://github.com/pithy-sh/pithy/commit/bd6b339d155ee5ec0746f42f5fb0e39d21a8f33d) Thanks [@kingmesal](https://github.com/kingmesal)! - Workflow and Durable Object logs are structured records now, not bare console lines — filterable by level and capability in Workers Logs, with errors carrying their full payload. New projects are scaffolded with a lint rule that keeps it that way, and you can turn it off.
  
  `logger.ts` has always said it: resolve the logger from the request context, never reach for `console`. Nothing enforced that, and nine calls had drifted into shipped runtime code — six of them in Workflow entrypoints, where there is no `c.var.log` to reach for and `console.log` is the shortest path to a line of output. Those six were the only observability a Workflow run had, and every one of them was an unstructured string: no level to filter on, no name to scope to a capability, no instance to correlate by, and a caught `PithyError` arriving as prose rather than lifted into the typed `error` field with its payload.
  
  `plugins/no-console.grit` is the gate, and `plugins/no-process-io.grit` is the same rule for `process.stdout` and `process.stderr` — the Node habit that reaches for a stream instead of a logger. Biome's own `suspicious/noConsole` matches the same code and is deliberately not used: its message is fixed and names no replacement, and a rule that only prohibits gets suppressed by the next person who needs a line of output. Both plugins match the member access rather than the call, so `items.forEach(console.log)` and `const sink = console.error` are caught alongside `console.log(x)`. Two files are exempt, and in both `console` *is* the implementation: `logger/local.ts` sinks to `console.error` and `logger/worker.ts` emits through `console.log`, which is how a record reaches Workers Logs at all.
  
  `bindWorkflowContext` is the Workflow peer of `bindRequestContext`. A run has no method or path; it has an instance id, and that is what anyone reading Workflows Logs searches by.
  
  `pithy init` scaffolds both plugins and both `biome.jsonc` entries into a new project, scoped to the Worker's own `.ts` source. Those files are yours — narrow them, widen them, or drop an entry and delete its plugin with it. Pithy ships the practice; the code is yours.
  
  `readCohort` and `resolveActivity` in `@pithy-sh/testers` take an optional `Logger`, so a degraded activity read is correlated to the request or the run that asked for it rather than surfacing as an orphaned line. Both default to the no-op logger, so no existing call changes.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A feature environment gets its secrets.
  
  `pithy provision --feature` created a real, deployable environment — D1, KV, R2, environment-scoped script names, service bindings — and touched secrets not at all. So a feature Worker composing `secrets` deployed and failed on its first request:
  
  ```
  {"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
  ```
  
  Worse than the same gap in staging, because the adopter chose staging. A feature environment is created by pithy, from a branch name, with every other resource wired automatically — so there was no reason to think secrets were the one thing to arrange by hand, and nothing said so.
  
  **A feature gets its own master key, and teardown takes it.** `pithy secrets deprovision` preserves a key unless explicitly asked, because losing it orphans every secret encrypted under it. For an ephemeral environment that reasoning inverts: nothing outlives the feature, so the key is the feature's and goes with it. `pithy feature destroy` removes every entry the feature could have named, by recomputed name, and leaves staging's and prod's alone — asserted, because the account's Secrets Store is flat and the name is the only partition there is.
  
  **`ManagedEnvironment` does not widen, and the argument is recorded in the source.** Since [#241](https://github.com/pithy-sh/pithy/issues/241) that type *is* the set the project declared, and everything iterating it multiplies with it — most of all a manager Worker with its own D1 and its own rotation cron, per environment. One per open pull request is not a cost a branch should carry. So the feature takes the narrow route: a key of its own and the bindings that reach it, and none of the durable machinery. The consequence is stated where an adopter meets it — a feature has no manager, so a secret it needs beyond the master key is reported as unbound with the command that creates it.
  
  **A `global` secret is bound, never copied.** It is one account-level value every environment binds; minting a feature's own would be a second copy of a value defined as one.
  
  The writer underneath is shared. `ProvisionScope` gained `secretEntry(secret, scope)`, so an entry name comes from the same object the resource names and the wrangler stanza do, and `applyProvisionedEnv` writes the `secrets_store_secrets` stanza for whichever scope it was handed. A declared secret whose entry has not been created is **reported rather than bound**: wrangler refuses a config naming an absent entry, so binding it would turn one missing value into a failed deploy of the whole Worker.
  
  Both provisioning writers now emit through the one JSONC printer ([#249](https://github.com/pithy-sh/pithy/issues/249)) rather than a raw `stringify`, and `src/ci/jsoncWriters.test.ts` states that as a rule about the call rather than a list of files — the gate that would have caught this one, which did not exist when [#249](https://github.com/pithy-sh/pithy/issues/249) landed.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy provision --env <name>` — the lifecycle step that was written for feature environments and never for the ones a project ships to.
  
  A project scaffolded, wired and migrated by pithy could not be deployed. `pithy add` runs the Worker's *dev* migrations, `pithy migrate --env prod` queries a database it assumes exists, and `pithy deploy` provisions nothing — so `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way. The first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in, after four commands had all succeeded.
  
  The provisioner was never the missing part. `pithy provision --feature` already resolves the Worker set, creates one resource per binding name, writes the ids into each Worker's own config and migrates. What was missing was the command, and the naming.
  
  **`ProvisionScope` is the naming, and it is why this is one object rather than two arguments.** A scope carries both the names a run composes and the `env.<name>` stanza it writes them into. `environmentScope(project, env)` gives `<project>-<env>-<thing>`, so a name's environment segment is always the stanza the name lives in; `featureScope(identity)` gives `<project>-f<issue>-<slug>-<thing>`, with the `f<issue>` marker instead of an environment because a feature *is* one. `provisionScope.test.ts` asserts that property over every scope, project, binding and kind, in both directions.
  
  That closes a hazard that was reachable before it: `pithy provision --feature --env staging` composed `<project>-f<issue>-<slug>-db` and wrote it in as staging's `DB`, in a checked-in `wrangler.jsonc`, then ran a remote migrate against it. Nothing refused it. **`pithy provision --feature` no longer takes an `--env`** — the combination cannot be expressed, rather than being on a list of things not to do.
  
  `pithy provision` is idempotent and **adopts**: every resource is matched by name before it is created, so a re-run is a no-op and a database made by hand under the right name is taken up rather than shadowed by a second. It writes a D1's `database_name` beside its `database_id`, because `pithy add` proposes the name offline and provisioning is the step that makes the proposal true. It creates the stanza when it is absent, so an environment declared after scaffolding needs no hand-editing. Seeding is off unless `--seed` is passed.
  
  **`pithy deploy --env <name>` refuses** when a binding has no resource behind it, naming the command that creates one — before anything is built or spawned. A deploy that silently created account resources would be hard to review, and these are the ids that land in a pull request.
  
  Production takes an exact, environment-naming phrase that `--yes` never replaces, and there is no `pithy deprovision`: staging and production are not disposable, and the one-word difference between them and a branch is not a difference a flag should carry.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A project declares which environments it has, and three parts of the CLI stop guessing.
  
  Nothing said. The set existed only as `env.<name>` stanzas in each Worker's `wrangler.jsonc` — per Worker, so two Workers in one project could disagree with nothing reconciling them — while `ManagedEnvironment` held a closed enum of `staging` and `prod` and `seed.productionEnvironments` invited a project to name a third. An adopter adding `env.live` got `pithy migrate --env live` working, `<project>-live-db` created, and `pithy secrets provision` skipping it: no master key, no manager, no store entry, silently, until the first request.
  
  The root `pithy.config.ts` now carries `environments`, defaulting to `["staging", "prod"]`. `pithy init` asks with that default — one keypress for the common case, and no line written into the config, because a declaration that repeats the default says nothing. A non-interactive `init` takes the default and is byte-for-byte what it always was. The list is ordered, least-production first: that is the order provisioning walks, and the last entry is the one a `global` account-level secret is written through, which used to be the literal `prod` even for a project that had none. `dev` cannot be declared — it is local, it is the top-level wrangler stanza, and it always exists. `global` stays reserved.
  
  **Declared and managed are one set, deliberately.** `ManagedEnvironment` is no longer a closed enum; it is the declaration. The cost is named rather than hidden: everything that iterates the set multiplies with it, and the largest item is a manager Worker per environment with its own rotation cron, so a project declaring five environments gets five managers. The alternative — a second, smaller "but only these are managed" list — is the bug restated, because an environment that deploys and is not managed is one whose secrets have no master key, which is exactly the silence `live` was already in. So declaring an environment is what costs a manager, and that is the one decision, in the one place `pithy doctor` can see it.
  
  `--env` refuses an environment the project does not declare, by name, listing the ones it does. `pithy init` and `pithy worker add` generate each Worker's `env.<name>` stanzas from the declaration rather than a hardcoded pair, with their binding arrays empty — a stanza that asserts nothing is the honest shape, and an existing project's scaffolded stanzas keep working untouched.
  
  **A fresh `init` still writes those stanzas**, and that is a decision with a reason in the source. `pithy add <capability>` writes bindings into the stanzas that exist and creates none, so a project scaffolded without them would have its very next `pithy add auth` bind `dev` alone and leave staging and prod silently unbound — a worse silence than the one this closes. Provisioning owning the stanza is right and is the follow-on work.
  
  `pithy doctor` gains an `Environments:` block and an `environments` key in `--json`. It reports a Worker whose stanzas disagree with the declaration, and — separately, because the remedies are opposite — a declaration changed **after** provisioning: an undeclared stanza still carrying resource ids. That one is never applied. `<project>-<env>-<thing>` is recomputed and never stored, so changing an environment name does not rename a database; it orphans it, exactly as renaming `name` does. The report names the ids and stops. A stanza whose bindings carry no ids is read as not provisioned rather than as broken.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A feature's provisioned ids never touch a tracked file.
  
  `pithy provision --feature` wrote feature-scoped ids into `apps/<worker>/wrangler.jsonc` — tracked, committed, and impossible to gitignore, because it is the project's real config. In CI that is correct as designed: the checkout is throwaway, wrangler reads the stanza, the job ends, nothing is committed. Everywhere else it was an expectation rather than a guarantee. A developer in a feature worktree carried a modified tracked file they had not edited, with nothing saying it must not be committed; `git add -A` put ids for since-deleted resources onto `main`. And `pithy feature destroy`, which reverses every other thing provisioning does, did not reverse the edit — the one part that outlived the feature.
  
  **The fix is a shape, not a warning: a provisioning run never writes a file a checkout tracks.**
  
  `ProvisionScope` gained `source` — is this environment's config source, or a build artifact? A declared environment's ids are long-lived facts about the repository and belong in the tracked file, under review, in a pull request a human reads. A feature's are facts about one job. So the same object that answers "what is this called?" and "which stanza does it go in?" answers "which file?", because those three answers have to agree.
  
  A feature's config is generated at `apps/<worker>/.wrangler/pithy/wrangler.feature.jsonc`, regenerated from the tracked file on every run so it cannot drift from it. `.wrangler/` has been in the scaffolded `.gitignore` since the first release and is ignored at any depth, so there is no new ignore rule and nothing for an existing project to adopt — which is the point: a rule existing projects lack would have left them exactly where they were. `main` is rewritten to an absolute path, because wrangler resolves a config's paths relative to the config file.
  
  One resolver decides which bytes describe an environment, and `migrate`, `seed` and `deploy` all use it; `deploy` passes it to wrangler as `--config`. `feature destroy` now has nothing to reverse, and a feature abandoned without teardown strands nothing.
  
  The gate is the sentence: after `pithy provision --feature`, every path whose bytes changed is one the scaffolded `.gitignore` already covers, and the Worker's own `wrangler.jsonc` is byte-identical — with a non-vacuity check, so "wrote nothing tracked" cannot pass by writing nothing at all.
  
  Worth stating: `pithy env` reports what a Worker's tracked config declares, so a feature environment does not appear in it.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - Provisioning is one command: `pithy provision --env <name>` or `pithy provision --feature`.
  
  Both create an environment's Cloudflare resources, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in the root `pithy.config.ts`, or derived from the checked-out branch. That is a flag, not a different verb.
  
  The safety lives in the scope rather than in the spelling. A `ProvisionScope` carries the resource naming **and** the `env.<name>` stanza the ids are written into, as one value — so a feature-named resource landing in a declared environment's stanza of a checked-in config is unexpressible rather than merely refused. Nothing about that depends on which words were typed, which is what leaves one command free to carry both modes.
  
  `pithy feature` is `create`, `sync` and `destroy`. All three derive the feature from the checked-out branch, so provisioning was the only verb there that a flag on `pithy provision` could say better.
  
  **Exactly one of the two flags is required, and neither is ever inferred.** Passing both, or neither, is refused at the flag — before the working directory is read, before a config is loaded, and before any Cloudflare client exists, which is why the refusal reads the same outside a project as inside one. `--feature` is never derived from "the branch looks like a feature branch": an implicit mode switch on branch shape is how someone provisions the wrong thing while reading a command line that says nothing about it.
  
  **The two modes have opposite persistence semantics, so every run says which it did and where.** `--env` writes `env.<name>` into the tracked `wrangler.jsonc` — long-lived ids a human reviews in a pull request. `--feature` writes a generated config under the already-ignored `.wrangler/` — one job's output, rebuilt every run, never committed. A single flag that flips whether output is committed will eventually surprise someone:
  
  ```
  Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
  Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
  ```
  
  `--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than infers it. That is what keeps the standing rule checkable rather than remembered — **a CI build process never commits back to the repository**: a pipeline runs `--feature` and has nothing to commit. The gate is the sentence: a run names every file it wrote, every file whose bytes moved is one it named, and `committed` is exactly whether those paths are tracked.
  
  **`feature` is now refused as a declared environment.** It was legal to write `environments: ["feature"]`, which gave one wrangler stanza two owners — a tracked file provisioning wrote and a generated file every other command read. It stays a legal environment *name*, because it is a real stanza key; it is the declaration that is refused, the way `dev` and `global` are. So `--env` cannot reach a branch's environment and `--feature` cannot reach a declared one, in both directions, by construction rather than by check.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - No capability asks an adopter to write down an origin.
  
  `originFor` landed the derivation; nothing scaffolded it and every capability still shipped a URL as its default, so `pithy add auth` wrote `baseURL: "https://api.example.com"` into a config that had no other answer. `pithy init` now scaffolds the shape the first adopter arrived at by hand:
  
  ```ts
  const DOMAINS = { /* staging, prod */ };
  export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);
  const config = { domains: DOMAINS, capabilities: [ … ], app };
  ```
  
  Hoisted, because the origin has to exist before the capabilities that take it are constructed — and `domains: DOMAINS` beside them is the same object, so there is one declaration with two readers. The domain prompt fills that const rather than inserting a second `domains` key, which is what the previous writer would have done to a config carrying one.
  
  A manifest option whose value is an origin now names a **constant** rather than stating a URL, and `pithy add` and `pithy upgrade` both render it unquoted. The vocabulary is closed — a manifest names `publicOrigin`, never an expression — for the same reason a capability's own name is constrained: a manifest is third-party data written into the adopter's TypeScript. A `--set` override still wins, and a project scaffolded before the constant existed keeps the literal rather than being handed an identifier nothing defines.
  
  `auth.baseURL`, `email.baseUrl` and `testers.baseUrl` derive. The gate found the third: the issue named three capabilities and the fourth was sitting there unreported. `controlplane.issuer` deliberately does not — it is an identity, not an address, and a connection minted in staging must stay verifiable in production — and it is the one named exemption on a gate that fails any other origin-shaped default.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - `originFor(environment, domains)` — one answer to "where is this Worker reachable", so no capability asks an adopter to write an origin down.
  
  Every capability that needs a public origin made the adopter type one, so a project with more than one environment wrote production's origin into staging's config. The first adopter's single Worker carried `https://app.pithy.sh` three times, in three capabilities, each wrong for staging in its own way: `auth.baseURL` mailed testers magic links **into production** and let the CSRF gate allow prod while refusing staging's own forms; `email.baseUrl` meant an unsubscribe from a staging test would have unsubscribed that person **in production**; the `payments` Stripe return URLs landed a staging payer **in production**, on an account that had bought nothing. Three capabilities, one mistake, three separate discoveries — because fixing it inside one capability does not stop the next capability asking the same question.
  
  The two halves already existed and nothing composed them. `domainFor` and `baseUrlFor` are now composed once, in `@pithy-sh/core/src/naming/domains`:
  
  ```ts
  const domains = { staging: { … }, prod: { … } };
  const PUBLIC_ORIGIN = originFor(compositionEnvironment() ?? "dev", domains);
  ```
  
  Named for the Worker rather than for whichever capability asked first. The adopter's own version was called `AUTH_BASE_URL`, which is part of why `email` and `payments` kept their literals for days — the constant read as auth's private business when it is the Worker's address.
  
  **The fallback is the load-bearing part.** An environment absent from `domains` is one that is not published, so it resolves to `http://localhost` and to nothing else. That fails closed: a link that goes nowhere, useless rather than harmful. What it replaces fell back to production's origin, which is the only version of this that was actively dangerous. And a *deployed* environment can never keep that fallback, because `pithy deploy` refuses an environment whose config declares no origin — one rule in two halves rather than two rules that happen to agree.
  
  `applyDomains` and `workerAddress` are routed through it, so `vars.BASE_URL` and the origins a Worker's capabilities were configured with are the same function's answer and cannot drift apart.
  
  **`controlplane.issuer` deliberately does not derive**, and the docs say why. It is an identity, not an address: a connection stores the issuer it was created with and verification checks that stored value, so a per-environment issuer would make a connection minted in staging unverifiable in production. That may be the better isolation, but it is a decision about trust rather than about reachability, and a helper whose job is "where am I reachable" must not sweep it up.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - Write every binding a capability requires, so a scaffolded project boots.
  
  `pithy init`, `pithy add email`, `pithy add auth`, `pithy dev`, `curl /health` — the shortest path through the product, in the order the docs teach it — answered `500` on **every** route. `@pithy-sh/auth` requires `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` requires `workflow:EMAIL_SENDER`, both non-optional, the composition correctly refused to assemble without them, and nothing wrote either one. Because it is every route, `/health` failed too, so the error named a binding and never the capability behind it.
  
  Both are now written by `pithy add`, per environment. A rate limiter is a policy with no resource behind it, so it lands at 100 requests per 60 seconds and is yours to tune. A Workflow entry names the capability's host across scripts — `<project>-<env>-<capability>-<job>` in `<project>-<env>-<capability>` — which is derivable offline, so the binding exists before `pithy <capability> provision` deploys the host. `vectorize` and `secret` stay unwritten and stay in `notes`: wrangler refuses a `vectorize` entry with no `index_name`, and a Secrets Store entry has no array in `wrangler.jsonc` to sit in.
  
  `isWrittenBinding` in `@pithy-sh/core` is the rule, and `capabilities/requiredBindings.test.ts` is the gate over it: a capability requiring a kind that neither `add` writes nor a provision command creates fails CI rather than a request. `project/scaffoldBoot.test.ts` runs the whole path — scaffold, add, compose, `GET /health` — with the Worker's env built from the files the commands wrote and nothing else, which is the gap the defect lived in.
  
  `pithy add` and `pithy upgrade` now write bindings through one function rather than two copies "kept in lockstep by intent". The two had already drifted: `add` stamped a capability's `remote` flag and wrote the Workers AI binding, `upgrade` did neither.

- [#272](https://github.com/pithy-sh/pithy/pull/272) [`5e93279`](https://github.com/pithy-sh/pithy/commit/5e9327927c0f59e1d94387f2880ddba0043ec600) Thanks [@kingmesal](https://github.com/kingmesal)! - An adopter can compose their own Better Auth plugins, and `pithy migrate` creates the tables those plugins need.
  
  `packages/auth/src/instance/auth.ts` hardcoded four plugins and nothing in the capability's config reached them, so an adopter who needed `organization`, `passkey`, `twoFactor`, `apiKey`, `admin` or a generic OAuth provider had two options: fork the capability, or stop using it. That is a large part of what Better Auth is, closed off by a list. `auth({ plugins: [organization()] })` is now the whole of it.
  
  **The four the kit composes are fixed, and additive is the rule.** `bearer`, `jwt`, `magic-link` and `emailOTP` are always present and are composed **first**; the adopter's list is appended. `magic-link` and `emailOTP` are the sign-in this product promises and there is no password to fall back to; `jwt` mints the JWKS the control-plane seam verifies against, and `bearer` is how a mobile client presents its credential. Better Auth merges plugin endpoints by id with the later registration winning, so "adding" one of the four would silently redefine it — a config that names one is refused at `auth()`, by name, and so is a list that repeats an id.
  
  **A plugin's tables are created, not deferred.** The kit's migration model had no path for tables an adopter introduced through a capability's plugin, and an app whose plugin queries a table nobody created fails at runtime on the first call. It needed no new path: the plugin list is in `pithy.config.ts`, which is the file `pithy migrate` already imports to collect capabilities. The auth capability asks Better Auth what schema the composed list implies, subtracts the schema its own four already imply, and contributes **one ordinary Kysely migration per plugin** — `0300_auth_0002_plugin_<id>` — beside `0001_init`, each with a tested `down`. Both halves of a plugin's schema are derived: `organization` creates `organization`, `member` and `invitation` **and** adds `active_organization_id` to `pithy_auth_sessions`, and a create-table-only reading would have shipped a schema where `setActive` fails on the first call.
  
  Three consequences worth stating. A column added to a table that already exists is **nullable** whatever the plugin declares, because SQLite will not add a `NOT NULL` column to a table with rows — Better Auth writes the value on every insert it makes, so the constraint holds where the plugin enforces it. A plugin's tables carry the plugin's own names, not `pithy_auth_*`; a collision with a table this capability owns, or between two plugins, is refused at `auth()` naming both, and a collision with a table another composed capability declares in the same D1 is refused at boot, which is the first moment anything can see both. And **removing** a plugin needs the same care as removing a capability — roll its migration back while it is still composed, then take it out of the config.
  
  **The client's surface is the adopter's to compose, and it needs no cast.** Better Auth builds a client from its own plugin list and the server's type never crosses into a browser bundle, so `organizationClient()` beside `organization()` is the answer, and `AuthInstance` is now parameterized in the plugin tuple for the one thing that genuinely needs the server's type — `inferAdditionalFields`. A typecheck-enforced test in the auth package compiles `authClient.organization.create(…)` with no cast anywhere in it.
  
  **Nothing an adopter plugs into a capability is invisible any more.** `Capability.extensions` is a new, additive, descriptive field on the composition contract — `{ kind, id, tables }` — and `pithy doctor` prints a `Capability extensions:` block from it. A composed plugin has no `package.json` for `Project capabilities:` to name it from, and it still adds routes to the Worker and tables to the database. The block is the only one in that report that is not a finding: an extension is a deliberate act, so it never fails the exit and `--terse` omits it. A capability declares its own, so the next extension point anywhere is a line in the report rather than a new check in the CLI.
  
  A project that composes no plugins is unchanged: one migration, no extensions, the same four plugins in the same order.

- [#286](https://github.com/pithy-sh/pithy/pull/286) [`d597eb3`](https://github.com/pithy-sh/pithy/commit/d597eb3c6f07c8bb47f5c00c19f7402f8327a46d) Thanks [@kingmesal](https://github.com/kingmesal)! - Semver and address normalization are primitives now, and the kit uses them.
  
  The kit exported neither, so the first adopter wrote both. Taken up before publication, when it costs one commit rather than a deprecation.
  
  `@pithy-sh/core/src/semver/semver` is semver §11.4, once: `parseSemver`, `formatSemver`, `compareSemver`, `semverGap`. The four rules that decide a release feed's order are each one line to get wrong quietly — numeric identifiers compare numerically and alphanumerics lexically, a numeric identifier ranks *below* an alphanumeric one, a longer identifier set wins when every shared one is equal, and a stable outranks every prerelease of the same core. Numeric identifiers are compared as digit strings, not through `Number`, because above 2^53 two distinct identifiers round to the same float and `latest` becomes whatever order the rows arrived in.
  
  The CLI's update notifier uses it and stays narrow: `parseVersion` still drops the prerelease, so nobody on the stable channel is nagged about an `rc.1`. Its tests pass unmodified. It now refuses a handful of strings it used to coerce — `1.2.` was `1.2.0` and `01.2.3` was `1.2.3` — none of which a registry ever returns.
  
  `@pithy-sh/core/src/address/address` is the one rule for whether two strings are the same person. It trims and lowercases both halves, and it deliberately does **not** collapse subaddressing or dots, unicode-normalize, convert IDN, or validate — the boundary is written down in `docs/CONVENTIONS.md`, because a normalizer that quietly merges two people is worse than none. `parseAddress` sits beside it for mail headers: unwrap `Ada Lovelace <ada@example.com>`, bound it, refuse anything that is not one address, return it normalized.
  
  Five capabilities compared addresses with five copies of `trim().toLowerCase()`, and a disagreement between them presents as "the suppression list did not work" rather than as anything about addresses. `auth`, `email`, `support`, `testers` and `matchmaking` now route through the primitive. `support`'s `normalizeAddress` and `email`'s `normalizeEmail` are gone; use core's `parseAddress` and `normalizeAddress`.

- [#289](https://github.com/pithy-sh/pithy/pull/289) [`e04870f`](https://github.com/pithy-sh/pithy/commit/e04870fab31169f0721e9625ef8609f66a0a9f5d) Thanks [@kingmesal](https://github.com/kingmesal)! - A failed migrate names what failed, and doctor sees a ledger row nothing declares.
  
  `pithy migrate` said, in full: *Migration run failed. Fix the migration. Run pithy migrate again.* No database, no migration, no cause — because the cause went to `detail`, which the terminal renderer never prints and the HTTP codec strips. Kysely had already named both. The runner now puts the migration, the binding it was running against, and what the runtime actually said into `message`, and keeps the throw-site half in `detail`: *Couldn't apply "0900_board_0003_broken" on DB. D1_ERROR: no such table: no_such_table: SQLITE_ERROR.*
  
  And the state behind that particular failure was not a broken migration at all. The ledger held a migration the project had deleted, which Kysely reads as a corrupted chain and refuses the whole run over. `pithy doctor` called the same database `migrations none pending ✓`, because pending is declared minus applied and a subtraction cannot see an extra.
  
  `readMigrationLedger` now asks both directions of one database in one read, and every caller takes the comparison rather than one side of it — `countPendingMigrations` is gone, replaced by `readProjectLedger`. `pithy migrate` refuses before it writes, at the same choke point that claims a database's owner; `pithy doctor` reports it on the `migrations` line and fails its exit. Both print the same sentence, from one writer: *DB records 0900_board_0002_tenant. This project no longer declares it.*
  
  "Fix the migration" is the wrong remedy for that — no migration is broken — so the action line says which case applies, from what the tool already knows. On `dev` the store is Miniflare's under `.wrangler/state` and deleting it costs a re-migrate. Anywhere else it is a database with real rows in it, where the same advice would be data loss, so the line says to restore the migration or remove its `pithy_migrations` row instead.

- [#304](https://github.com/pithy-sh/pithy/pull/304) [`da4525b`](https://github.com/pithy-sh/pithy/commit/da4525b6097fb2f8eca3a06b4a0e02ad66634b3d) Thanks [@kingmesal](https://github.com/kingmesal)! - The catalog never reached the control plane, so a grant was an unvalidated free-text key.
  
  Each product carries the entitlement keys it grants, and that is a dropdown: *Pro (subscription) → grants `pro`*. It was projected in exactly one place — `clientProjection`, inlined into the adopter's own client bundle — so it reached their players' browsers and never a management client. A console offering "comp this person an entitlement" had nothing to populate a list from, and `EntitlementGrantRequest.entitlement` took a key nothing compared to anything. An operator who meant `pro` and typed `pr` got a 200, a row, and a customer who stayed locked out. Invisible on both sides, and permanent until somebody read the table — a bad failure for a support action whose whole premise is that the person is already unhappy.
  
  **`GET {base}/admin/catalog` — `payments:catalog:read`.** Its own scope, granted separately, because reading what a project sells is not reading what anybody bought: this route names no account and no transaction and answers identically against a database with no rows in it. It publishes each product's `id`, `type`, `name` and `entitlements`, and that is all — strictly less than the browser projection, which also carries the Stripe price id. No price, no store SKU, no rail identifier, no `grants` block: `clientProjection`'s own argument for keeping the SKUs and the economy server-side is the specification, and a management client filling a list of comp-able things needs less again. The rule is enforced as an invariant rather than a field list — every string and number in the response must be one of those four facts about some product — so a field added later carrying a price fails whatever it is called.
  
  **And the grant validates against it.** `POST {base}/entitlements/grant` refuses a key no product grants with `payments/entitlement_not_in_catalog`, a 400 naming the key. 400 rather than the 404 a missing SKU gets: a grant names the vocabulary gating code is written in, not a resource. The refusal echoes the key the caller sent and never the set it got wrong — what a project sells is a separate disclosure, behind the scope above.
  
  **Gating on a key nothing sells stays possible, and is now declared.** `manualEntitlements` in the payments config lists the keys the control plane may grant with no product behind them — a beta flag, an internal tier, a founder comp — and they are offered on the catalog read beside the products, so a console does not omit from its list the very keys it would then submit. The escape is explicit rather than achieved by not checking: with it empty, every key outside the catalog is refused. Only grants are constrained. A revoke of a key the catalog has since dropped stays legal, or a catalog edit would be irreversible for every account still holding it.
  
  **An empty catalog is a state, not an empty list.** A project that sells nothing and declares nothing answers `{ enabled: false }` — the same modeled answer `clientProjection` gives, so "composed with nothing to sell" reads as itself rather than as a dropdown that came back broken. A catalog that failed to *load* is a non-200 or a body that does not parse, which no branch on `enabled` can confuse it with.

- [`550252e`](https://github.com/pithy-sh/pithy/commit/550252e8304bc1f9a6bf94d440c50f8a6b974616) Thanks [@kingmesal](https://github.com/kingmesal)! - State what a projection may publish, instead of listing what it may not.
  
  Four surfaces that cross a trust boundary were guarded by lists of strings that must not appear in the response — a ciphertext, a snapshot marker, `payload`, `s3cret`, a handful of credential shapes. A negative list is complete only against the values somebody thought of, and a projection widens by gaining a *field*, which is the one event no value list can observe.
  
  `unpublishedIn` from `@pithy-sh/core/src/projection/published` is the invariant in its positive form: every leaf in the document must be a fact the surface publishes, and every key must be one written out by hand in the test. Both halves, because either alone lets the mistake through — `true`, `false` and `null` are in every JSON document's vocabulary, so only the key half can police a new boolean, and only the leaf half can catch a forbidden value arriving under a name nobody predicted. A value JSON cannot express is refused rather than skipped: a fallthrough returning "nothing to see" for a whole type is the defect this replaces.
  
  Applied to the secrets status read and rotation history, the payments client projection, and the two management row projections. The payments catalog read, which had the first version of this sweep inline, now calls the primitive rather than keeping a fifth copy of a walker whose first draft was blind to booleans and nulls.
  
  The permitted key set is a literal at every call site, never `Object.keys(Schema.shape)`. A gate that reads its own subject cannot fail when the subject changes.

- [`7eef492`](https://github.com/pithy-sh/pithy/commit/7eef492699697a1c964da9d54059caef54c51ff9) Thanks [@kingmesal](https://github.com/kingmesal)! - Put a capability's numbers on the manifest, so a client stops paying a round trip per count.
  
  A management client that wants to say "3 secrets need rotating" beside a rail had to call again — once per capability it wants a number from, against a customer's production Worker, on every screen load. The count is not the expensive part. The round trip is.
  
  A capability may now contribute a bounded health summary to its own manifest entry, declared alongside its routes with `defineCapabilityHealth`. `@pithy-sh/secrets` contributes one: how many secrets are past the cadence their registry entry declares.
  
  Three rules keep it from becoming a data API, and each is in the type rather than in a comment. **Scalars only** — a value is `number | string`, so a projection, a row, or a collection that grows with an adopter's data does not compile. **A closed vocabulary per capability** — the manifest carries the declarations beside the values, so a client renders a key it has never heard of from what the Worker says about it, and a value the declaration cannot name is refused before it reaches the wire rather than dropped. **Nothing that costs a table scan** — `cost` is `memory` or `indexed` and has no third member, so a value that would need one cannot state its cost and therefore cannot be declared.
  
  A withheld number and a zero are different facts. Each key names a scope the capability's own admin routes already require, checked at assembly — a scope no route requires is one an adopter is never offered at connect, so the number could never be granted, and that composition now refuses to boot. A connection without the scope gets `null` beside a non-empty `healthKeys`, never `0`, and the producer is not run at all.
  
  The seam is branded: only the factory can build a declaration, so nothing reaches a manifest unparsed.

- [`704f8fa`](https://github.com/pithy-sh/pithy/commit/704f8faf6e94aafe115df7d74ac34b1f868b211f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy upgrade` counted bindings it had not written, and `pithy doctor` was right to disagree.
  
  Run in sequence, seconds apart, against one tree: `upgrade` said `payments: added 3 bindings` and `git diff apps/board/wrangler.jsonc` showed none of them. `doctor` still reported `PAYMENTS_RECONCILE (workflow) missing from wrangler.jsonc`. Two commands of one CLI disagreeing about a file one of them had just edited, with the failing direction the dangerous one: `upgrade` says done, so a reasonable person deploys a Worker whose reconciliation Workflow has no binding, and finds out at runtime.
  
  Two causes, both fixed at the thing rather than the call site.
  
  **Six capabilities derived their Workflow bindings with `Object.values`, and the job is the map key.** `payments`, `storage`, `support`, `vector`, `testers` and `media` each carried the same four lines, and `createBackend` carried them a seventh time. Dropping `job` and `className` is not cosmetic: the CLI composes a `workflows` entry's deployed name from the job and its `class_name` from the class, refuses to write a partial one because wrangler rejects it, and had no way to say so. `workflowBindings` in `@pithy-sh/core/src/workflow/bindings` is now the one derivation, `Object.entries` where it belongs, and every producer routes through it.
  
  **And the report came from the plan.** `applyBindings` recorded what it *intended* the moment it touched a capability. `appendBinding` now returns what happened — written, present, unsupported, or skipped with a reason — and `upgrade` reports off that. A binding it could not write gets a line of its own, named:
  
  ```
  payments: PAYMENTS_RECONCILE (workflow) not written for dev — PAYMENTS_RECONCILE declares no job.
  ```
  
  The gate that should have caught this was green and structurally unable to fail: it checked workflow bindings for `job` and `className` over `requiredBindings.filter((b) => !b.optional)`, and every affected binding was optional. `optional` answers whether the app may boot without the binding. It says nothing about whether the entry is derivable offline, which is the question that gate asks. It now asks it of every workflow binding, and a sweep over the shipped manifests holds `upgrade`'s report to the file it wrote and to the plan `doctor` reads afterwards.

- [`57c6df1`](https://github.com/pithy-sh/pithy/commit/57c6df11e5e553de8b034aba66db929dbd165c3e) Thanks [@kingmesal](https://github.com/kingmesal)! - A secret says where it comes from and how it is replaced.
  
  The registry has always known which secrets the kit cannot mint — no `devValue` — and nothing about how a human is supposed to get one. So `doctor` said *not set*, `secrets ls` said *not set*, and every client that wanted to say more carried its own table of names that went stale the moment a capability was added.
  
  Two axes, on the registry entry and mirrored into `pithy.manifest.json` as `secrets[]`, the route `devSecrets` already proved. **`origin`** is `minted`, `helped`, or `obtained`. **`rotation`** is `local`, `provider`, or `manual`. They are separate because neither follows from the other: a GitLab token is `obtained` and rotates by `provider`; an OAuth client secret is `obtained` and rotates only by a human. A Cloudflare account token is `helped` to create and `provider` to roll — one secret, two mechanisms, which is the case one axis cannot express.
  
  `SecretRecipe` is a union, not an enum, and `SECRETS_ENCRYPTION_KEYS` is why. It is minted — by `initialMasterKeyConfig` — and its value is an `EncryptionConfig`, so a recipe that knew only `random` would have failed to describe the first secret it was drafted around. `recipe: "encryptionConfig"` says both halves, and the entry still carries no `devValue`, because nothing arbitrary fills it.
  
  One axis, enforced. `defineSecretRegistry` refuses an origin without a rotation, a minted secret that does not rotate locally, a `devValue` without a random mint or a random mint without a `devValue`, and a structured mint on a text entry. `secrets()` now runs its merged registry through that check, so the master key is held to the rules every adopter's secret already was.
  
  A `documentation` link is `https:` and nothing else. `z.url()` accepts `javascript:alert(1)`, and this field is read out of `node_modules` and rendered as an anchor an operator clicks.
  
  An unrecognised issuer parses to `other` rather than failing, so a manifest written by a capability added tomorrow still renders in a client built today.
  
  Auth's four OAuth pairs now name the settings page a human goes to. Auth's session secret and email's link signing key declare the random mint they already performed. The secrets manager's Cloudflare token declares the permission groups `pithy token mint secrets` asks for, so nothing downstream repeats them.

- [`19312ab`](https://github.com/pithy-sh/pithy/commit/19312aba66567a06fa46ef3394711eadd3f8bd1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Give Workflow steps a stated retry classification, and stop retrying answers that cannot change.
  
  A Workflow is chosen because of its retry semantics. A step that inherits the platform default has not decided — it has deferred, and the default is retry-everything. So `create` refusing a secret name that already exists, which is the write path working, was backed off and re-driven as though the name might stop existing. Measured against a real Workflow in `wrangler dev`: the duplicate write errored after **32.2 seconds**. It now errors after **0.9**, on the first attempt.
  
  `classifiedSteps` in `@pithy-sh/core/src/workflow/faults` is the seam. A capability states the error codes it retries and the reason a second attempt could answer differently; core answers for D1's vocabulary through the classifier `withD1Retry` already had, so a fault the inner layer refused to retry is terminal at the step too; everything else is terminal. Retry is opted into, never inherited. The conversion happens **inside** the step callback, because by the time a `step.do` promise rejects the retries have already been spent.
  
  Secrets and payments state theirs — `secrets/already_exists` and `secrets/not_found` are terminal, an unreachable Cloudflare API is not; an unreachable store fails a reconcile page so it re-drives, every other refusal about a purchase does not. Email's is stated and tested in `send/retryPolicy.ts` beside the `E_*` table it agrees with.
  
  `core/src/workflow/retryClassification.test.ts` is the gate: every Workflow entrypoint hands its step to the classifier and uses it nowhere else. It discovers the population from the tree, asserts it against two hand-written lists, and was planted against — a raw `step.do` and a newly added Workflow each fail it. The seven Workflows still on the platform default are listed there and tracked in [#348](https://github.com/pithy-sh/pithy/issues/348).

- [`de57027`](https://github.com/pithy-sh/pithy/commit/de57027baf1d17e3554ba7da0821224fc2457bb1) Thanks [@kingmesal](https://github.com/kingmesal)! - Give `action` an audience, and enforce it where the boundary already is.
  
  `PithyError` classified two of its three text fields. `message` was safe to expose, `detail` was stripped by the HTTP codec, and `action` was neither — so it went to the browser with everything else. Read the ones the kit ships and what it is becomes unmistakable: `Run \`pithy vector provision\``, `Bind a D1 database named DB in wrangler.jsonc`, `Set \`name\` in pithy.config.ts`, `Take the ${rail} credentials from <provider console> and set them with \`pithy secrets set\``. That is a sentence for somebody with the project checked out, and it was being handed to whoever tripped the error.
  
  **`action` is operator-facing.** It now sits beside `detail` on `ErrorPayload` and is absent from `PublicErrorPayload`, so the wire shape has no such key to fill — the strip is a property of the schema, per code and without exception, for an adopter's own codes exactly as for the kit's. A remedy the *caller* needs has always had a field: `message`.
  
  The operator's surfaces keep it. `renderTerminal` is unchanged, and the CLI's `--json` error line now encodes through `operatorError` rather than through the HTTP codec — both drop `detail`, but they drop it for different readers, and whoever ran the command is the person who can act on a wrangler binding.
  
  Two remedies that a caller genuinely needed moved to `message`, where they are said in the open rather than carried by a field nobody had classified. Storage now answers a half-finished multipart upload with the route that resumes it, and the dev-login page — which registers only in a `dev` composition outside CI, so its browser is the developer's own — still names `pithy seed`.
  
  Also: `<config>/cloudflare.json` promised that another tenant's key is "read and written back untouched" and silently deleted a `__proto__` one. `JSON.parse` gives it an own property, the parse skips it while rebuilding the object, and the write puts back what it was handed. The read-modify-write now refuses that document rather than quietly dropping the key from a file holding a live API token.

- [`84e3325`](https://github.com/pithy-sh/pithy/commit/84e332579c3ce5ac2c8e0d4f5e7134a4d8105413) Thanks [@kingmesal](https://github.com/kingmesal)! - Put the client boundary above the transports, and take `action` off the socket.
  
  [#344](https://github.com/pithy-sh/pithy/issues/344) classified `action` as the operator's and stripped it where the boundary was written: the HTTP codec. A Durable Object pushing an error frame down a player's WebSocket never touches that codec, and multiplayer's session object built its frame by hand — `{ code, message, action }`. So the remedy that was removed from every HTTP body was still going to the browser over a socket, and the rule read as satisfied because the rule was phrased in terms of one transport.
  
  **`clientError` is now the one place an error becomes bytes for a client**, whatever the transport. `HttpError.encode` calls it. The multiplayer session's frames are built from a `PithyError` through it, and the frame builder takes nothing else — there is no hand-written shape left to disagree with the schema. What it strips is not a list this function maintains: both fields are removed by name and the result is parsed by `PublicErrorPayload`, which has neither key, so an adopter's own code is held to the same boundary as the kit's.
  
  The census of every other transport that could serialize an error toward a browser, because the point of a fix at the thing is that the next one arrives already correct:
  
  - **`@pithy-sh/matchmaking` presence socket** — sends presence frames and `pong`, and never an error payload; an upgrade it refuses answers with a fixed string and a status. Safe as written.
  - **The DO ↔ Worker RPC envelopes** (multiplayer's `guard`, matchmaking's `guardRpc`) — carry the whole payload, `action` and `detail` included, deliberately: both ends are ours, and the route revives a real `PithyError` that then leaves through `clientError`. A malformed envelope propagates as a bare `Error` and lands in `detail`, which is stripped. Safe.
  - **The HTML surfaces** (`@pithy-sh/testers` opt-in pages, `@pithy-sh/email` callback pages) — fixed copy, no payload rendered. **No SSE anywhere in the kit.** **No Workflow or queue consumer** returns an error to a client; failures go to logs, rows, and the audit trail, which are operator surfaces and keep `action` on purpose.
  
  One thing found and left alone: `@pithy-sh/payments`'s browser client still reads `action` off an error body it can no longer receive, and surfaces it as `PaymentsFailure.action`. It resolves to `null` on every real response — dead, not leaky — but it tells a reader the wire has a field it does not.

- [`513483b`](https://github.com/pithy-sh/pithy/commit/513483b8476fd6c32ea5e880211b869a2bb8a7cb) Thanks [@kingmesal](https://github.com/kingmesal)! - Give a capability's health summary a fourth state, so one sick store stops blanking the manifest.
  
  [#317](https://github.com/pithy-sh/pithy/issues/317) got three states right — nothing declared, withheld for want of a scope, and zero — and left the fourth to a reviewer, on purpose. A producer that throws is none of those, and returning `null` for it would have made a broken store indistinguishable from a number a caller may not see. That reasoning was right. The behavior was that the throw propagated, `GET /control-plane/manifest` failed whole, and one capability's bad afternoon took every other capability's number with it, with nothing on screen saying which one.
  
  A manifest entry's `health` is now a four-state value: `undeclared`, `withheld`, `reported` with its scalars, and `unavailable`. The state rides **on** the value rather than beside it, so a scalar is unreachable without narrowing on `state` and a consumer that forgets the sick case gets a type error rather than a screen reading zero. A flag next to the numbers would have been the same information and the opposite property.
  
  A producer that throws — or that reports what its own declaration cannot name — now costs that capability's number and nothing else. Every sibling still resolves.
  
  **Nothing from the throw travels.** `unavailable` carries no message, no code and no detail, and the caught error is dropped whole rather than logged: a health producer runs inside a customer's data path, so what it puts in `detail` is a query, a row, or a key id. What survives is that this capability could not say, and its name, which the manifest already carries in public.
  
  The wire keeps two flat fields — `health` and a defaulted `healthUnavailable` — and the schema is a codec between them and the four-state value. A Worker deployed before this sends no flag and lands where it always did, and a client pinned to an older build strips a field it has never heard of and reads silence rather than a zero.
  
  `namedHealthValues` takes the four-state value and names nothing for anything but `reported`. A surface that must say *why* there is no number reads `state`.

- [`fc7f19f`](https://github.com/pithy-sh/pithy/commit/fc7f19f6a4248eef00c98d6e907a14846a99a169) Thanks [@kingmesal](https://github.com/kingmesal)! - A Workflow can send mail. `enqueueFromEnv(this.env, input)` reaches the composed email capability from inside a durable step, with the from-identity and theme `pithy.config.ts` resolved and nothing restated.
  
  A `compose` hook hands every composed capability to every other one, so a route can hold `@pithy-sh/email`'s bound `enqueue` and call it — `@pithy-sh/auth` does exactly that for magic links. A Workflow class cannot: the runtime constructs it with the worker `env` and nothing else, and a composed seam is a closure rather than a binding. The two ways past it were both the adopter's to take and both wrong — rebuild the seam from `env` plus a restated sending identity, free to drift from the config that owns it, or pass the closure through Workflow params, which are serialized.
  
  So a durable job could not send mail, and `pithy-sh/dashboard`'s key-rotation notice was written, tested, and reachable by nothing: a monthly unattended pass over credentials into other people's production systems, whose most valuable notification was the one that could not be delivered.
  
  `createBackend` now records the composed set after every `compose` hook has run, and `@pithy-sh/core/src/capability/composition` publishes `composedCapabilities()` and `composedCapability(name, guard)` to read it. It is reasoned rather than convenient: `createBackend` runs at module load and Cloudflare requires a Workflow class to be exported from the same worker entrypoint as the `fetch` handler, so the composition has already happened in that isolate before any step body runs — the same footing `@pithy-sh/secrets`' shared accessor stands on. A second assembly replaces the first rather than merging, and an un-composed isolate raises a wiring fault naming what to compose rather than answering emptily.
  
  This is not a service locator for application code. A route has `c.var` and a capability has its `compose` hook; both are better and both stay the way to reach a seam. It is for the one caller that has neither.

- [`fe6081a`](https://github.com/pithy-sh/pithy/commit/fe6081a7d517789e81b7772ed2dea7a56a2fb745) Thanks [@kingmesal](https://github.com/kingmesal)! - Publish a reader's contract beside every management projection, so a client survives an enum member it has never heard of.
  
  One schema per projection has served two consumers with different obligations. A Worker validating its own projection is checking itself and must be strict — `SupportChannel` is what `inbound/` branches on and what D1 holds, and a tolerated-unknown member there would license a capability to store a channel it cannot handle. A management client reading that response is crossing a trust boundary: the Worker is a fork, a bug, a half-finished deploy, or hostile, and one unrecognised member cost it the whole response. `pithy-sh/dashboard#15` rendered zero of twenty-five conversations for exactly one such token, and the client that fixed it had to hold a widened copy of our shape — the mirror `[#113](https://github.com/pithy-sh/pithy/issues/113)` exists to forbid.
  
  `asRead` from `@pithy-sh/core/src/projection/asRead` is the pattern, stated once for the kit: the producer's object with every enum reachable through it read as a string, every other field the **identical schema instance**, and every description carried over with a sentence saying what the field now permits. It is not a loosening — a missing field, a wrong type, a number outside its bounds, a body that is not an object all still refuse the whole response. It is not a mapping — the token comes back verbatim, and the enum stays the authority a client asks. And it is not selective: a reader does not control the writer, so widening two enums and leaving a third is how the same blank pane returns one field over. A shape `asRead` cannot see through — a union, a record, a tuple, an object with its own unknown-key rule — throws at construction rather than passing through unrewritten.
  
  `@pithy-sh/support` publishes six: `SupportThreadViewAsRead`, `SupportListedThreadViewAsRead`, `SupportMessageViewAsRead`, `SupportThreadsResponseAsRead`, `SupportThreadResponseAsRead`, `SupportArchiveResponseAsRead`. The producers are untouched and still refuse what they always refused; a test asserts both halves over the same field, and a gate walks each published contract for an enum it failed to widen, against a producer proved to hold one. The submitter's own views stay strict — an app reading its own Worker is not reading a stranger.
  
  Closes the local widening in `pithy-sh/dashboard`, which was filed as a stopgap.

- [`cd5c150`](https://github.com/pithy-sh/pithy/commit/cd5c1504739fbf39513cd5b0dc469093007df903) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy secrets rotate` — a secret declared how it rotates, and now something rotates it
  
  [#322](https://github.com/pithy-sh/pithy/issues/322) landed the declaration: `rotation.kind` of `local`, `provider` or `manual`, per secret, crossing into `pithy.manifest.json` so any client can branch on it. Nothing acted on it. `pithy secrets` had `create`, `update`, `rm`, `ls`, `edit`, `provision` and `deprovision`, and a management client could not honestly draw a rotate control over a command that did not exist.
  
  ```
  pithy secrets rotate <NAME> --env <env> [--dry-run] [--json]
  ```
  
  **Built around the one failure it cannot undo: a provider roll succeeds and the store write fails.** The old credential is dead at the issuer, the new one exists only in the process that received it, and rolling again issues a third value and loses the second — so the retry meant to save it is what destroys it. The ordering is the design. Every refusal happens before anything is called; the value is produced exactly once; the store is retried three times against that same value and never reaches back for a fresh one.
  
  That state is reported as its own outcome, with the secret named and the environments still holding the retired credential named beside it, and it exits **3** — distinct from `1`, which means the previous value is still live and the command can simply be run again. It carries its own error code, `secrets/rotation_unrecorded`.
  
  **The value is discarded when the store will not take it, and the failure says so.** Printing it would leave a live production credential in shell scrollback, in the CI log, and in whatever recorded the session — permanently. The failure instead names the issuer, its documentation page, and the `pithy secrets update` that records a value rolled by hand, all composed from the declaration [#322](https://github.com/pithy-sh/pithy/issues/322) added. The rotation result has no field that could carry a value, so this is structural rather than a habit.
  
  - **`local`** re-mints from the same recipe that created the value. **`provider`** calls a rotator attached to the registry entry — the seam `rotation/valueRotator.ts` declared inert and this makes live. **`manual`** prints the console, the page, and the command that records the result, calls nothing, and never prints `Done.`
  - **`--dry-run`** resolves the declaration and stops. No account, no credentials, nothing rolled.
  - **No `--all`.** A fleet rotation wants more than one confirmation *and* an audit entry naming the operator, and a CLI audit records `system, actorResolutionFailed` when no Cloudflare token names one. The act most certain to be reviewed afterwards would be recorded as *somebody with the token*. `pithy secrets ls` and a shell loop force the operator to see the list first.
  - `SECRETS_ENCRYPTION_KEYS` is refused by name: it is the key every other secret is read through, and it rotates on its own axis inside the manager.
  - Rotations are audited as `secrets/rotated`, `critical` on the unrecorded state, carrying the name and the environments and nothing else.
  
  Driven end to end with the real binary against a local stand-in for the Cloudflare Workflows API, including the forced roll-succeeded-store-failed path — asserting the rotator rolled exactly once across three store attempts, and that no value it issued reaches either stream or any file the CLI writes.

- [`b1bf0fb`](https://github.com/pithy-sh/pithy/commit/b1bf0fbee38e1f2e3854b529502e8046f7327f49) Thanks [@kingmesal](https://github.com/kingmesal)! - A secret rotated and no client could see how, or ask for one.
  
  `[#322](https://github.com/pithy-sh/pithy/issues/322)` put `rotation` on the registry entry and `[#367](https://github.com/pithy-sh/pithy/issues/367)` shipped `pithy secrets rotate`, and neither reached a remote client. `SecretStatusView` carried eleven fields and `rotation` was not among them, so **no shape a management client could read said whether a secret rotates by `local`, `provider` or `manual`** — and `rotatable` is explicitly not the same question (`SECRETS_ENCRYPTION_KEYS` is `local` and `rotatable: false`; a payments credential is `rotatable: true` and rotates only by hand). A client's only conservative reading was to give every secret an instruction and none of them a control. There was also no `POST` anywhere in the package, so there was nothing for a management client's rotation to open.
  
  ## `rotation` on the status read
  
  `GET {base}/admin/status` now reports each secret's rotation declaration verbatim: the kind, the issuer, and the documentation page. `null` when the entry declares none, which is a different fact from `manual` — nobody has said, rather than somebody has said it takes a human.
  
  No value fits in any of it. A kind from a closed set, an issuer from a closed set, and a URL the schema holds to `https:`, copied from a registry entry `defineSecretRegistry` already validated. `SECRET_RESPONSES_CARRY_NO_VALUE` still holds, the exact-field-set tests still assert the whole shape, and the response sweep now names the three nested keys explicitly rather than deriving them. An issuer a client has never heard of parses as `other` rather than throwing, so a Worker newer than its reader still renders.
  
  ## `POST {base}/admin/status/:name/rotate`, behind `secrets:rotate`
  
  Its own scope, and that is the load-bearing decision. `scopeCovers` matches exactly, so a scope confers every route requiring it — a rotation behind `secrets:status:read` would have handed credential replacement to every adopter who ever wanted a status pane, retroactively and without being asked. It never enters a default grant either: `defaultGrant` classifies by route method, and every route requiring this scope is a `POST`.
  
  **A rotation supplies nothing, which is why this write can exist where create and update cannot.** A management client holds neither the adopter's registry nor their Zod schemas, so it could not write a value against the schema that governs it. A rotation's successor is produced *inside* the Worker — minted from the entry's own recipe, or returned by the rotator its registry entry carries — so no value crosses in either direction. The route takes no body at all.
  
  It answers `rotateSecretValue`'s outcome faithfully and per environment: `rotated` / `unchanged` / `unrecorded` / `failed`, with `recorded` and `stranded` named, `rolled` and `rollFailed` distinguishing *was rolled* from *may have been rolled*, and no field a value could sit in — `cause` is dropped at the projection, because an exception raised inside a rotator is raised in the one place a credential is definitely in scope. **200 for every status, including `unrecorded`**: throwing would render one sentence and drop `recorded` and `stranded`, which is the "all rotated" summary over a partial failure the whole design refuses.
  
  Every rotation opens a `pithy_secrets_rotations` row against the management client's own subject, before the roll, and closes it after — so *who rolled the production key on the twelfth* has an answer, a rotator that never returns still leaves a trace, and a rotated secret stops reporting overdue. Audited as `secrets/rotated`, the same code the CLI emits for the same act, `critical` on `unrecorded`.
  
  ## A Worker rotates less than the CLI does, and says so
  
  `pithy secrets rotate` runs in a process holding the project: the registry from source, a Cloudflare token, a dispatcher to every environment's manager. A Worker holds one environment's D1 and its own master key. So a `cf-secrets-store` secret (an account-level entry written through Cloudflare's API with a token an app Worker must never hold) and a `global` secret (identical everywhere by definition, and writing one environment would strand the rest under one name) are refused with the new `secrets/rotation_unsupported` (409), naming the command that can — before anything is called.
  
  So is a name this environment has never stored. `runWriteSecret` in `update` mode raises on a missing name, and reaching that raise *after* a provider roll would manufacture the unrecorded incident out of a configuration gap that cost nothing to check.
  
  `secrets/rotation_unsupported` is its own code because a client has three different things to render and only one of them is a mistake: *you may not* is a scope refusal, *it broke* is a fault, and this is neither — it is *run the command*. The free path is in `message`, since `action` is stripped at the HTTP boundary.

- [`47e40ff`](https://github.com/pithy-sh/pithy/commit/47e40ff274e03100da64b87f5af190bf3025f2e4) Thanks [@kingmesal](https://github.com/kingmesal)! - Three contracts a scaffolded front end used to freeze in silence.
  
  **`/health` is one statement.** It was written in four places — `createBackend` mounted it, the route allowlist seeded it, `pithy deploy`'s probe appended it, and the bare home screen fetched it — and nothing compared any pair. That screen is the only one a project with no auth composed gets, and its whole content is the request: a rename in the kit rendered *"The worker says: unknown."* with a 200, no error, and nothing in a log. `HEALTH_PATH` in `@pithy-sh/core/src/worker/health` is now the one statement all four read. It imports nothing, so the client bundle can hold it without a server runtime.
  
  **The paths frozen at scaffold are checked by resolving them.** `vite.config.ts`'s `persistState` depth, both tsconfigs' `tsBuildInfoFile`, and `tsconfig.client.json`'s `include` are all relative to `apps/<worker>/`, and every one of them reads identically whether it is right or wrong. A wrong depth gives two Workers separate copies of one database. A narrowed `include` makes `tsc -b` exit 0 over a program holding no screens — the client's whole typecheck, gone, with no change in output. The gates live in the scaffolder's suite now, where a real project exists to resolve against, and each was proven red by planting the defect in one.
  
  **The unstyled report can fail a run, and runs again.** It checked whether Pithy's screens render styled, then printed once at `pithy ui add` and never asked again — while `styles.css` is the adopter's, so the ordinary way a screen loses its rules is an edit a week later. `pithy ui sync` re-runs it and `--check` exits 1 on a finding, alongside the shadowed-route check it already made. It reads every `.css` under `src/` rather than the paths a run planned, so a rule in a stylesheet Pithy never wrote counts. `docs/UI.md` says when it runs, what fails, and the one blind spot it keeps: a `className` given a bare identifier is not read.

- [#417](https://github.com/pithy-sh/pithy/pull/417) [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy dev` runs every Worker your project composes, and mail sent from localhost is delivered for real.
  
  Signing in with a magic link against `pithy dev` wrote a row, called `sender.create(...)` on a Workflow binding naming a Worker that was not running, swallowed the throw on purpose, and left the job `pending` forever while the screen said "Check your inbox." The safety net that justifies the swallow is a cron on the same absent Worker. A developer's first conclusion is that their Cloudflare Email Service setup is wrong, and they go and check it, because the product told them the mail was sent.
  
  **It was never an email problem.** Nine capabilities ship a committed host-Worker template — email, media, payments, storage, support, testers, vector, secrets and leaderboard — and `discoverWorkers` enumerates `apps/*` and only `apps/*`. No capability host had ever run under `pithy dev`. Email is simply the one with a symptom a person notices, because a magic link is the first thing anyone tries.
  
  **A host Worker is now an ordinary member of the dev set:** a pinned port, a label and color in the terminal and `logs/dev.log`, an entry in `.dev-state.json`, reaped with everything else. One `wrangler dev` per Worker — the process model did not change.
  
  **Pithy wires the dispatch; wrangler does not.** `<STEM>_PORT` and `<STEM>_ORIGIN` were already how a Pithy Worker reaches a sibling, so a Workflow dispatch travels that wire in three shared pieces in `@pithy-sh/core/src/workflow/`: a dispatch route a host mounts, which starts an instance against its own same-script binding and is **refused outside `dev`**; a loopback dispatcher satisfying the one-method seam by posting to `<STEM>_ORIGIN`; and a host env contract. Deployed environments keep the cross-script binding untouched.
  
  **A host states what it is missing, at boot.** `EmailWorkerEnv` is fourteen fields and nothing validated any of them: a missing `BASE_URL` became a link to `undefined/…`, an unparseable `EMAIL_THEME` threw inside a render step, a `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` became `NaN` and the scheduler claimed nothing, quietly, forever. Every one of those was discovered as a mail that did not arrive. Now it is a Zod object with a `.describe()` per field, validated at startup, logging each missing value beside the binding, var, command or config key that provides it.
  
  **`enqueue` stopped reporting a send it knows cannot happen.** A structurally absent dispatcher is a configuration fact known at compose time, not a transient error, so the row is born `undispatched` and the result says so. A dispatcher that is present and throws keeps exactly its old behavior — the safety net is real then. `undispatched` is not a dead end: the scheduler claims those rows beside `pending` under the same grace window, because a tick running at all is the host existing.
  
  **`dev` sends for real by default** — `"remote": true` on the host's `send_email` binding, the same pipeline and DKIM as `prod`. When there is no usable Cloudflare login or the sending domain is not onboarded, that is said before somebody is waiting on an inbox, and the session falls back to the local simulator with one line in the banner rather than dying or going quiet. The simulator is also reachable deliberately, which is what CI and a plane want.
  
  The feature port block widened from 10 to 20, pinned against the host count, because eight hosts plus a two-Worker scaffold filled a block of 10 exactly and a third Worker threw.

- [#417](https://github.com/pithy-sh/pithy/pull/417) [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` checks that your capabilities' settings work, not only that they are wired.
  
  Config drift, required bindings, the migration ledger, project name, worker name, environments, dev vars, secret bindings — every check `doctor` had was a question about presence. None was a question about the value. So a project could be entirely green while `fromAddress` named a domain nobody onboarded, the link-signing key was never created, `BASE_URL` was staging's URL in production's config, `EMAIL_THEME` did not parse, or the suppression database did not exist. The option key was there, the binding was declared, the migrations were level, and no mail arrived.
  
  A capability now declares a settings check on its `Capability` object, beside `health`. **Discovery keys on the capability instance and never on `pithy.manifest.json`** — `@pithy-sh/matchmaking` and `@pithy-sh/rating` are published capability packages that ship no manifest, and a manifest-keyed rule silently skips both. That is the same trap the version stamper documents, and it is not walked into twice.
  
  **One schema, two readers.** The local tier validates through the same Zod object the capability's host Worker validates at boot: the Worker refuses to serve without it, `doctor` reports it before anything is deployed, and neither can drift from what the code actually requires — which is the failure a hand-written doctor check has every time.
  
  **Two tiers, and three outcomes.** Local is pure and offline and always runs. Account costs a Cloudflare call. Both are faults: a local finding makes the project unhealthy and `doctor` exits non-zero, and an account finding does the same *when the account was reached*. When it cannot be reached, the account tier is reported as **skipped** — never as passed, and never as the account's fault when the failure was local. A check that never ran keeps the report verbose rather than letting silence read as a pass.
  
  Every finding renders as a problem line and an action line naming the `pithy` command, config key or one-time account action that resolves it, and every finding and every skip appears in `--json`. The check never writes anything.
  
  `@pithy-sh/email` declares the first one. A `Local delivery:` block joins it, backed by the same `deliveryPreflight` call `pithy dev` decides with, so the two commands cannot disagree about whether mail will go out. It never gates the exit — running the simulator is a choice — and it prints even in the terse report, because silence there reads as "of course it sends".
  
  `secretBindings` and `devVars` are untouched. The account tier is simply where "does the store entry exist" is finally asked, which `secretBindings` deliberately refuses to.

- [#418](https://github.com/pithy-sh/pithy/pull/418) [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc) Thanks [@kingmesal](https://github.com/kingmesal)! - An entitlement is held by a subject, and a subject is not always a user.
  
  `pithy_payments_entitlements` was `UNIQUE (userId, entitlement)`, and every read of it asked who a person is. That is right for a consumer app and wrong for every business that sells to companies: the organization signs, the organization is invoiced, and everybody in it holds what it bought. Modeling that on a user-keyed table meant granting to every member — a fan-out that drifts the moment somebody joins — or granting to the owner, which makes the plan theirs and shows an invited colleague `Free` while their employer pays for Team.
  
  So the holder is a pair. `subjectType` is a closed enum, `user` or `organization`; `subjectId` is its id. Both halves travel together in every row, every comparison and every provider reference, because nothing in the kit keeps an organization id from equalling some user's id — a check that read one half would let one hold the other's subscription. `pithy_payments_purchases` and `pithy_payments_provider_accounts` move with the entitlements table, so a webhook resolving to an organization writes an organization everywhere and never half of one.
  
  **`billingSubject` is required, with no default.** One answer per project: a codebase that could grant to a person on one route and a company on the next is one where the two eventually disagree about who is entitled, and the disagreement arrives as somebody refused something they paid for. It is not defaulted because it decides what a stored row means, and a project that meant `organization` and never saw the question finds out when it has subscriptions. `pithy add payments` asks; a `--json` run that does not say is refused, naming the flag.
  
  **The capability never learns what an organization is.** It has no members table and no business acquiring one. Under organization billing it asks the adopter *which subject is this caller acting for*, through a `resolveSubject` function on `payments()`, and the adopter answers from its own session. Unanswered is unentitled — a read holds nothing and a write raises `payments/subject_unresolved`. There is no fallback to the authenticated user anywhere.
  
  The spelling is `organization`, with a z. It is the stored token in a column and a UNIQUE index, and it has to match Better Auth's `organization()` plugin — the only realistic way an adopter has organizations at all — whose `activeOrganizationId` is what a resolver reads on the line above.
  
  A denial now says *who* it was for. `payments resolved []` used to be the whole sentence, and it meant two different things — a company that has bought nothing, and a caller acting for no company at all, which is the ordinary state of somebody signed in with no organization selected. Those want opposite fixes. The resolver seam gained an optional `holder()` reporting a display label and a tenant, and the denial's audit row now carries that tenant, so a trail answers "which of our customers is hitting the paywall" — `actorId` never could, because one person acts in two organizations. It is deliberately not the holder itself: a label is prose and a tenant is an audit dimension, so there is nothing there for a gate to compare a caller against, and a test pins that the gate's decision is identical for every holder including none.
  
  Three consequences worth stating rather than discovering. `resolveSubject` is a function, so it cannot cross the `JSON.stringify` into `PAYMENTS_CONFIG`: the reconcile and Paddle sweep Workflows always run with no resolver, and read every subject off a stored row. `@pithy-sh/ledger` is a per-user model, so a catalog that credits a balance is refused at composition under organization billing rather than at the purchase: an account is `(userId, currency)` and every route the ledger serves reads a user id, so a company's credit has nowhere to land that anything would read. A user's ledger account stays exactly what it was, their user id. And `@pithy-sh/support` resolves a person from an email address with no request to ask the seam, so its billing panel covers individually-billed purchases only and now says so on the wire instead of returning an empty list.
  
  The migration is amended in place rather than chained, and it carries nothing across: nothing is published and no database holds a payments row. `pithy payments reconcile --user <id>` becomes `--subject user:<id>` — an id on its own is refused, because it names whichever holder happens to carry it.

- [`0133b53`](https://github.com/pithy-sh/pithy/commit/0133b53ccec0eb03664bb3ff289a19f4c716d33c) Thanks [@kingmesal](https://github.com/kingmesal)! - The manifest says what a project bills, so a management client can write a grant.
  
  A route says where to call and which scope to hold. It never said what to **send**. `POST {base}/entitlements/grant` names the holder and never assumes it, and whether a project's holders are people or organizations is `PaymentsConfig.billingSubject` — required, with no default. A client could not read it, so it could only guess, and against a project billing the other kind the guess is refused. The dashboard's Users record refuses both entitlement acts for exactly that reason, and no scope and no plan opened it.
  
  A capability now states **configured facts** on its own manifest entry: `configKeys` is the closed vocabulary, `config` is what this deployment resolved each one to. Read them with `namedConfigValues(entry)` from `@pithy-sh/core`, which drops a fact nothing declares — so a client of an older build renders what it knows and nothing for the rest. Payments states one, `billingSubject`, with its choices read off `PaymentsSubjectType`.
  
  A fact is not a health number, and the two are easy to confuse because they sit side by side. A number is per caller, is produced, may be `unavailable`, and is rendered. A fact is the same for every caller, is read off resolved config at assembly, cannot fail, and is **respected** — it goes into the next request rather than onto a rail. `defineManifestConfig` is the only constructor: scalars only, a value nothing declares is refused, and a value outside its own `choices` never gets built, so a capability cannot put its provider credentials on a discovery read. A fact whose values are not enumerable writes `choices: null`; an empty list is refused at the declaration, because nothing could satisfy it and the refusal would name no permitted value at all.
  
  Both fields are defaulted rather than required. A Worker deployed before them sends neither, and its manifest still parses whole.

- [`4ef5951`](https://github.com/pithy-sh/pithy/commit/4ef595178dddfc38e128f16c560cb9aa7769f1ae) Thanks [@kingmesal](https://github.com/kingmesal)! - A Durable Object class the config names is exported by the entry, so the project deploys.
  
  `pithy add multiplayer` wrote both halves of the wrangler config for a Durable Object — the `durable_objects.bindings` entry naming a `class_name`, and the `new_sqlite_classes` migration tag registering that class against the script — and neither half says where the class *is*. wrangler resolves `class_name` against the entry's module `main` names and refuses the deploy when nothing there exports it:
  
  ```
  Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file:
  MultiplayerSession.
  ```
  
  The scaffolded entry is `export default createEntrypoint(config);` and nothing else, and `createEntrypoint` returns a value — a value cannot add a named export to the module holding it. So the last line was left to a human whose only prompt was a sentence of manifest prose. `pithy add multiplayer` and `pithy add matchmaking` produced projects that did not deploy, three classes between them, and the failure arrived at `wrangler deploy` rather than at the command that caused it.
  
  **The module is now the capability's to state.** `BindingSpec` gains `classModule` beside `className`, required for a `durable_object` binding and refused as a bare word — it is written into generated TypeScript, so it is validated as a module specifier rather than trusted as a JSON string. Every writer that touches a binding now writes the matching export: `add`, `remove`, `upgrade` and `--eject`. `pithy upgrade` had the identical defect and is fixed with the rest of them; a capability added by one command and reconciled by another cannot have two answers.
  
  **Reported, too, and not only written.** `pithy upgrade`'s plan carries `missingEntryExports` per capability and `pithy doctor` fails on it under `bindings` — a Durable Object is one binding written in two files, and a check that read only the `wrangler.jsonc` half called a project healthy that `wrangler deploy` refuses. That is the same defect one level up, so the plan reports what the apply writes.
  
  **The gate derives the rule instead of listing the classes.** For every manifest the repository ships, it takes the classes the real writer put in `durable_objects.bindings` and the exports the real scaffolder wrote into the entry — parsed with oxc, honoring `exportKind` so a type-only export does not count — and requires the second to cover the first. Neither side is enumerated, so a fourth class added tomorrow is covered by a test nobody has to remember to update. Watched failing against all three classes before any writer existed, and again with a `classModule` pointed at a module that does not exist.

- [`1071ace`](https://github.com/pithy-sh/pithy/commit/1071aceaad8a9d9e4acc9ac8b14c239cdc6ffe31) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy speaks Spanish. Compose `i18n`, and every screen, error and email answers in the reader's language.
  
  **The seam is in `@pithy-sh/core`, and it is always there.** `c.var.t` is on every request whether or not you compose anything — a translator over the English each composed capability contributed through the new `Capability.messages` — so a capability writes `c.var.t.t("auth/invalid_token")` with no null check and no config, exactly like `c.var.log`. `@pithy-sh/i18n` replaces it with one that negotiated the reader's locale and merged the catalogs behind it. **A project that never composes it is byte-identical to one from before this landed**: same strings, same bytes, no negotiation. That property is what the whole design is arranged around, and it is why `Translator` lives in core while the capability stays optional — your own module can type against the seam whether or not you ever opt in.
  
  **Two locales, and only one of them falls back.** `catalogLocale` is the locale whose words answered, and it falls back: an `es-AR` reader reads `es`, because `es` is what somebody wrote. `formattingLocale` is what goes to `Intl`, and it does not: that reader gets `es-AR`, which `Intl` supports natively whether or not a translator ever did. So Buenos Aires gets Spanish sentences and Argentine dates, from one translator, with nobody writing an `es-AR` catalog. Collapsing the two is the bug the pair exists to prevent.
  
  **A catalog key is `<domain>/<path>`, and a capability may only write under its own name.** That is the `pithy_<capability>_<table>` rule and the `auth/invalid_token` rule for the third time, enforced by `composeMessages` for the same reason: the domain segment is what makes two capabilities' contributions incapable of colliding, so merge order stops being something anyone reasons about. It binds the adopter's own `app` capability identically — `board/nav.settings` is theirs, `auth/sign_in.title` is not. **Overriding** a kit key is always allowed and is one entry; **declaring** a new key under a kit domain is refused. Lookup is per key across the layers, never per catalog, which is what makes an override a merge rather than a fork.
  
  **The server never localizes an error, and that is a deliberate refusal rather than a gap.** `ErrorPayload.message` stays English permanently: it is simultaneously the operator's diagnostic in the log line and the audit row, and the fallback for every client that cannot do better, so translating it would lose the first to gain the second. The payload gains one optional `params` beside `message`, and a translating client renders `t.maybe(payload.code, payload.params) ?? payload.message`. **For an error the key is the code** — `auth/invalid_token` is a catalog key and an error code and the same string — so there is no second identifier to keep in sync and `KitErrorCode` is the exact checklist a locale has to cover. The schema edit is one line into `publicFields`, which is spread into all 120 kit members; `params` is optional and absent, so a body a client already receives is unchanged byte for byte, and `clientError`'s arity does not move.
  
  **A person's locale lives in exactly one place: `pithy_auth_users.locale`.** It is the one kit field on the user table declared `input: true` — a reader's own preference is the opposite of a device id, and refusing client input would leave an admin route as the only way to store one. What makes that safe is the validator, not the type: Better Auth runs the same `Locale` schema on the write that guards every read, so a caller cannot poison a row every listing then parses. It is nullable, and **null is not `en`** — it means nobody chose, which is what makes the server fall through to `Accept-Language`. Do not add a second home for it in a preferences table: display formatting is one fact and language is another, and two homes is a magic-link email in the wrong language with nothing failing to say so.
  
  **An email is rendered twice, so the locale rides on the row.** The subject renders at enqueue, inside a request that knows the reader; the body renders at send, inside a Workflow with no request on it at all. `pithy_email_jobs.locale` is what makes those two agree, and what lets an operator reading a send log see why a subject read the way it did. The seven templates whose words the kit writes are translated with it. The five whose words arrive as payload are not — their **shell** follows the job's locale and their copy is yours, so a notice at `es` reads its severity in Spanish and its summary in whatever the caller wrote. That is the right behavior and it is a surprise unless stated, so `docs/I18N.md` states both halves and says what to do about it.
  
  **The screens keep the only catalog that survives being copied.** Every seeded screen renders through `t.t(key)` now, and the English those keys resolve to sits in a `satisfies MessageCatalog` block inside the same file — because the file is yours from the moment it is written, and the English cannot live in a package you might never install. The translations are the other half and are **never copied into your tree**: they ship inside `@pithy-sh/i18n`, so a typo fix or a new language reaches you as an upgrade rather than as a merge. With a provider mounted the baked catalog goes **last** — your catalog, then the kit's translation, then the file's own English — and `useTranslator` never throws for want of one.
  
  **Coverage is a `pithy doctor` check, not a `pithy i18n` command.** For every locale you serve, every key reachable in the default locale must be reachable in that one too; a gap names the locale and the missing keys and already fails `doctor`'s exit code. That is the whole of what the command would have been, at none of its cost — no new page in `docs/commands/`, no row in the five exact-count and byte-pinned CLI gates a new command moves. There is no account tier: nothing about language is a question for the Cloudflare API.
  
  **Four gates, because every one of these properties is only true as a set.** `ci/catalogCoverage.test.ts` is repo-wide and derives the English side from the three places a kit sentence actually lives — the templates' baked blocks, `EMAIL_MESSAGES.en`, and `KitErrorPayload.options` — then compares it against `KIT_CATALOGS` in both directions, because a Spanish key no English key answers is a typo that is invisible forever. `ci/errorArgs.test.ts` exists because `params` landed in seventeen of eighteen throw-sugar arg types and the one that was missed compiled, linted and tested green. `ui-react/src/templateCopy.test.ts` sweeps the templates for prose outside a catalog, as a text sweep rather than a GritQL rule, because `JsxText()` never sees an `aria-label` and the sign-in screen's provider buttons carry their copy there. And `plugins/no-z-config.grit` bans Zod's global error map outright: a Worker isolate outlives the request, so a locale written there renders the next request's validation failure in the last request's language.
  
  **What stays English is a decision, and it is written down.** Operator surfaces — CLI output, `renderTerminal`, `--json` lines, logs, audit rows — are English permanently, so they stay greppable and keep matching the docs; `action` is the operator's field and names commands and bindings, which do not translate. **Zod's field-level `issues[]` also stay English in v1**, and that limit is stated in `docs/I18N.md` rather than left to be discovered: Zod 4.4.3 has exactly the right primitive in its per-parse error map, but `@hono/zod-validator@0.9.0` calls `safeParseAsync(value)` with no third argument and its `validationFunction` hatch receives `(schema, value)` and never the `Context`, so reaching it needs `AsyncLocalStorage` and is out of scope.
  
  **The Spanish is 242 messages and it says so about itself.** 120 error codes, 71 screen strings, 51 email strings, and every file in the locale directory carries `// LOCALE es — an unreviewed first pass. Not American English by design.` in its head. Two facts in one line, both load-bearing: the American-English census reads the tag rather than a path list, so it still reads a file declaring `en`, and a first pass that claims to be finished costs more than one that says what it is. The exact spelling is published in `docs/I18N.md` so an adopter's own prose census can teach it ours instead of inventing a second one.
  
  **`pithy_auth_users` gains its `locale` column by amendment, not by a second migration.** `auth_0001_init` is amended in place under CONTRIBUTING.md's pre-publish rule — every package is `0.0.0`, nothing is published, and no database anywhere holds a row a `0002` would have to carry across. `0001_init` *is* the schema. The day a version is cut this inverts, and the column becomes history that a migration adds rather than one the baseline declares.
  
  **One declaration of the kit's Better Auth columns, because two of them were already wrong.** `makeAuth`'s live options and the schema baseline `pluginSchemaDelta` subtracts each adopter plugin from were both written out by hand, each with a comment saying it must match the other and a test claiming to hold them together — a test that compared the baseline against the `User` schema and never imported `makeAuth` at all. There is one `KIT_USER_FIELDS` / `KIT_SESSION_FIELDS` now, imported by both, and nothing left to disagree with. Leaving a kit column out of that baseline is not cosmetic: `pluginSchemaDelta` reports it as something an adopter's plugin brought, and an adopter plugin also declaring a user `locale` then emits `ALTER TABLE … ADD COLUMN locale` against a table that already has one — a duplicate-column failure part-way through a migration D1 cannot roll back, because it has no transactional DDL.
  
  **Every other package here gains one optional `params` field on its throw sugar and nothing else**, which is why they take a patch: no behavior moves for anyone who does not pass it, and passing it changes only what a translating client can render.
  
  **Two additions to core's seams are worth knowing about even if you never compose `i18n`.** `Translator.maybe(key, params?)` answers `null` on a miss where `t()` answers the key, which is what makes `t.maybe(payload.code, payload.params) ?? payload.message` fall back at all — written against `t` it never does, because `??` sees a string and takes it. And `AuthContext` gains `locale`, published from the user row the session lookup already loaded, so a reader's stored language outranks their device's `Accept-Language` at no extra query.

- [`c9f2016`](https://github.com/pithy-sh/pithy/commit/c9f2016f3472213f9360bce740cac969f1efb632) Thanks [@kingmesal](https://github.com/kingmesal)! - The locale marker's reader ships beside the marker.
  
  `docs/I18N.md` publishes the line that declares a file is not English, so an adopter can teach their own prose census to read it. The reader was private — three functions inside a test file, in a package, that nothing could import — so every adopter with a spelling or pronoun census hand-ported them by reading a test.
  
  `localeDeclared` and `valueSpans` are exported from `@pithy-sh/core/src/i18n/localeMarker` now, and `packages/cli/src/ci/americanEnglish.test.ts` consumes its own export, which is what stops the published marker and the shipped reader drifting apart.
  
  The half that is easy to get wrong is documented at the export, because a porter reading the marker by eye gets it backwards: **the marker exempts the file's quoted values, not the file.** Prose outside quotes — docblocks, identifiers — is still censused, and `en` or `en-*` is a declaration and never an exemption. A census that read it as "skip this file" would silently stop reading the docblocks of every translated catalog it ever added.
  
  The head window the guide states is now pinned to the window the reader reads, from both sides.

- [#460](https://github.com/pithy-sh/pithy/pull/460) [`a9d0368`](https://github.com/pithy-sh/pithy/commit/a9d0368637888d18a136251e41e97de3dd08347b) Thanks [@kingmesal](https://github.com/kingmesal)! - A seed can ask where its own Worker answers.
  
  `SeedPrepareContext` carried `env`, `project`, `secret`, `preferences` and `seeded`, and nothing that said what origin the environment would answer on. So a set that registers something pointing back at the app — a self-connection, a webhook target, an OAuth callback — had nothing to ask, and wrote the address down. The kit's own first adopter did exactly that: `const DEV_ORIGIN = "http://localhost:8787"`, under a comment predicting its own failure.
  
  **The port is allocated, not configured.** Each checkout reserves a block and pins one port per Worker into `.dev.config.json`, which is the whole reason two features can run at once. That makes the literal right in the first checkout on a machine and wrong in every other one — a connection that registers cleanly, pings, and denies every real call. Worse when the first checkout is also running, because then the second one addresses the first one's Worker.
  
  `context.origin` is that address, resolved from the allocation the run was actually given.
  
  **Read back, never recomposed.** `buildDevConfig` mints `http://localhost:<port>` in exactly one place, and the seeder reads that string rather than composing a second one — two rules for one value is how the two disagree later. A test writes a config whose origin and port disagree and fails anything that recomputes it.
  
  **An address, not an identity.** It says where to reach this Worker, on this machine, now. Nothing stored and verified later — an issuer, an audience, a signing scope — may be built from it, because the same project answers on a different origin in every checkout and every environment.
  
  **`null` is an answer.** A clone that has never run `pithy dev`, a Worker added after the block was pinned, or any environment but `dev`: a deployed address is declared rather than allocated, and `pithy env` is what answers it. `resolveWorkerAddress` still returns `null` for `dev` for the same reason in reverse — a localhost URL is not a deployed Worker's address. A set that cannot work without an origin refuses and says so, because an invented one would be indistinguishable from a real one.
  
  The acceptance test drives two real port allocations against one machine-wide registry and asserts the two runs see different origins, each equal to what its own checkout was pinned. No port literal appears in an assertion — a fixture that named one would pass against the defect.

- [#470](https://github.com/pithy-sh/pithy/pull/470) [`b9219d8`](https://github.com/pithy-sh/pithy/commit/b9219d83ab90b7bc69ede9b590f2cc7ee5855d35) Thanks [@kingmesal](https://github.com/kingmesal)! - The control-plane seam answers CORS preflights, so a browser can reach it.
  
  A control-plane token rides the `pithy-control-plane` header, which is not one a browser sends cross-origin without asking first. Nothing answered that question, so the browser-direct path — the one that exists so your data goes straight from your browser to your own Worker instead of transiting a management client's origin — failed on every call, as a `TypeError` naming your host. A Worker that was up and healthy read as one that could not be reached.
  
  Every admin route now answers `OPTIONS`: the seam's own, and every capability's. The covered paths are derived from the same `adminRoutes` descriptors the manifest is built from, so a capability that adds an admin route gets its preflight with it and there is no second list to keep in step.
  
  The hosted dashboard works on a stock Worker with no configuration. Add your own console with `allowedOrigins`, which is **additive** — an entry there never removes `issuer`, so putting your own UI on top cannot lock out the dashboard that was already working:
  
  ```ts
  controlplane({ allowedOrigins: ["https://ops.example.com"] })
  ```
  
  In local dev you configure nothing: when `ENVIRONMENT` is `dev`, any address on your own machine is answered, on any port. The dev port allocator picks a console's port per feature, so no value you could write down would stay true across checkouts.
  
  `pithy-worker-version` and `pithy-worker-version-created` are named in `Access-Control-Expose-Headers`, so a client can finally tell "the Worker did not say" from "the browser was not allowed to look" — different facts when you are deciding whether a deploy has landed. `corsMaxAgeSeconds` caps how long a browser caches a preflight; set it to `0` while you are working an allow-list out, because a browser that cached a refusal keeps refusing after you have fixed the config.
  
  Two things are deliberate. The allow-list is read from config and never from a connection row: a preflight is the one request here answered before any credential, so consulting the database would let anyone ask which origins you have registered. And an origin that is not allowed gets the same `204` and the same empty body as one that is, minus the header that permits the read — the browser blocks it, and the answer says nothing about what the list contains.

- [#472](https://github.com/pithy-sh/pithy/pull/472) [`aaaeeff`](https://github.com/pithy-sh/pithy/commit/aaaeeffce8e921e2dbf71e946768cffd1da6cace) Thanks [@kingmesal](https://github.com/kingmesal)! - A management client can now tell a good number from a bad one.
  
  A health key declared what a value *means* — `key`, `kind`, `states`, `scope`, `cost`, `summary` — and never what it *should be*. `secretsDueForRotation: 0` is the good answer; a `verifiedSenders: 0` would be a fault; the two declarations are identical in every field. So a client holding the number, the scope and an English sentence could render it and nothing more. `pithy-sh/dashboard` shipped that section under a heading reading **Health**, with the good answer presented as a finding, and then removed it — the vocabulary could not support the verdict the heading claimed.
  
  `HealthSummaryKey.nominal` is that claim: `{ atMost }` / `{ atLeast }` for a count, the nominal members for a state, and `null` — the default — where the capability grades nothing. `standingOf(key, value)` answers `nominal`, `attention`, or **`unknowable`**, and `healthAttention(descriptor)` is the values wanting somebody's attention, in declaration order.
  
  **`unknowable` is never `nominal`, and that is the whole design rather than a detail of it.** A key that declares no bound is a key nobody can grade; answering `nominal` there would let a client read healthy because nothing told it otherwise — which is this defect relocated one level up rather than removed. It is `[#350](https://github.com/pithy-sh/pithy/issues/350)`'s choice one layer down: that made the four report states a discriminated union so a consumer forgetting the sick case got a type error instead of a screen that lies. A value whose *type* contradicts its `kind` is `unknowable` too — `checked()` runs on the producing side, and a client parses manifests from Workers it does not control. A `state` value outside its own declared list is not that case: it is still a string, so it is graded, and it is `attention` — a Worker reporting something it never said it would send is not a thing about which nothing can be concluded.
  
  Nothing has to declare one. `nominal` defaults to `null`, so every manifest built before this parses unchanged and every value on it stands at `unknowable` — bit-for-bit today's behavior. A newer Worker reaching an older client is stripped by a non-strict object, as `healthKeys` already relies on. No capability gains a declaration here: whether `@pithy-sh/secrets` claims `{ atMost: 0 }` is that capability's decision, not this change's.
  
  The shape of `nominal` is decided by `kind` and refused both ways — an array on a count and a bound on a state each throw — because a refine written for one direction admits the other. A count's bound must bound something and be satisfiable; a state's nominal must name members that key declares, or the claim is one no producer could ever match.

- [#76](https://github.com/pithy-sh/pithy/pull/76) [`dd224b1`](https://github.com/pithy-sh/pithy/commit/dd224b1aeffcb0bc9b0c105015acc5b460817d94) Thanks [@kingmesal](https://github.com/kingmesal)! - `chunkByBoundParameters` sizes an `IN (…)` list against D1's cap of 100 bound parameters, minus what the rest of the statement already binds. Chunking at the cap itself is the bug it exists to prevent: a `where` beside the list pushes the statement to 101, and nothing notices until there is enough data to fill a chunk.

- [#85](https://github.com/pithy-sh/pithy/pull/85) [`3c8ffb3`](https://github.com/pithy-sh/pithy/commit/3c8ffb30480595354e83447c8dda2e2e9611f4a1) Thanks [@kingmesal](https://github.com/kingmesal)! - `@pithy-sh/wallet` is now `@pithy-sh/ledger`.
  
  A wallet sitting next to a payments capability invites the wrong inference — that a verified purchase tops up the wallet. It does not, and it never will: the two share no seam. `ledger` is what the thing has always been. The README's first line said so, the domain module said so, the migration said so. Only the package name did not.
  
  The rename is total. Package `@pithy-sh/ledger`, capability `ledger`, tables `pithy_ledger_*`, migration namespace `ledger`, error codes `ledger/*`, admin scope `ledger:admin`, routes under `/ledger`. `@pithy-sh/multiplayer`'s wager seam follows: `WalletEffect` is `LedgerEffect`, `applyWalletEffects` is `applyLedgerEffects`. The migration order stays 650 — renumbering a released capability re-runs its migrations, so the constant was renamed, never renumbered.
  
  Two names that stuttered under the new one are resolved. The migration is `ledger_0001_accounts`, named for the tables it creates, composing to `0650_ledger_0001_accounts`. The primitive moves up to `@pithy-sh/ledger/src/ledger` and is `openLedger(env.DB)`, so it no longer collides with the `ledger()` capability factory.
  
  Nothing had been published, so there is no deprecation path and no adopter carrying `pithy_wallet_*` tables. That window closes at the first release; this is the last cheap moment to do it.
  
  **Any database that already ran the old migration needs resetting.** The composed key moved from `0650_wallet_0001_ledger` to `0650_ledger_0001_accounts`, and Kysely refuses to migrate a database whose bookkeeping names a migration the provider no longer offers — `pithy migrate` fails with `corrupted migrations: previously executed migration 0650_wallet_0001_ledger is missing`. Nothing published is affected; what is affected is a dev machine or a preview environment migrated before this landed. Locally, delete the project root's `.wrangler/state` and migrate again — it is dev data, and no `down` exists for a key this branch no longer ships. For a provisioned feature environment, tear it down and re-provision.

- [#86](https://github.com/pithy-sh/pithy/pull/86) [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f) Thanks [@kingmesal](https://github.com/kingmesal)! - New seam: entitlements. `@pithy-sh/core` now owns what an entitlement is, how a request resolves the caller's, and `requireEntitlement("pro")` — the gate that belongs on a paid route's line beside `requireAuth()`. **The uncomposed default denies**, which is the one deliberate difference from the audit seam: a missing audit write cannot grant anyone access, but a missing entitlement check can, so a Worker with no provider composed holds nothing and every gate 403s. The gate lives in core rather than in the provider for the same reason `requireAuth()` is copied into each capability instead of imported from `@pithy-sh/auth` — a gate that arrives with a package fails open when that package is absent. Denials are audited through the `emit()` seam as `entitlement/denied`, and the reason (genuinely unentitled, or nothing wired) rides in `detail`, where an operator sees it and a client never does. Runtime denial is the backstop, not the primary defense: `pithy doctor` and `pithy dev` now compare the `requireEntitlement()` calls in a Worker's own source against whether any composed capability declares that it provides entitlements, and report the gap — so a Worker gating on entitlements with nothing to resolve them reads as a composition error at development time rather than as production 403s that are indistinguishable from a user who has not bought anything.

- [#88](https://github.com/pithy-sh/pithy/pull/88) [`fcb9502`](https://github.com/pithy-sh/pithy/commit/fcb950247371ca44c978b600d5bc1bdbd72b93b9) Thanks [@kingmesal](https://github.com/kingmesal)! - The `control-plane` seam: inbound, adopter-authenticated admin access to your own Worker, with no data plane in between.
  
  `control-plane` has been a declared strategy with nothing behind it. Now it is real, and it ships present-and-denying: a Worker that composes it and has never been connected answers every control-plane route with 403, and there is no flag that changes that. `pithy dashboard connect --env production` is the deliberate second step; `pithy dashboard disconnect` is a row you delete, immediate and needing nothing from anybody else.
  
  The credential is asymmetric. A management client holds an Ed25519 private key; you hold, rotate, and revoke the public one. Nothing secret of yours ever leaves your infrastructure, so a breach on their side is not a breach on yours — which a shared HMAC secret could never have offered. Each call carries a 60-second, single-scope token bound to a digest of its own body, checked against a replay set, and audited under its own actor kind, so what a management client did is answerable separately from what your users did.
  
  Rotation is append, prove, then expire — never replace. A rotation that fails leaves the old key working rather than locking anyone out. Proof is by use: the call that retires a key must itself be signed with the successor, because naming a live key is not evidence you can sign with it. The Worker refuses an expiry that names a key other than the one that signed, and refuses one that would leave no live key at all. Lockout is the one failure mode with no recovery path, so it is rejected rather than trusted not to happen.
  
  Revocation comes at two sizes. `pithy dashboard disconnect` removes the connection; `pithy dashboard revoke-key` pulls a single leaked key and leaves the rest standing. Both are writes to your own D1 and need nothing from the client — revocation that required the other side's cooperation would not be revocation.
  
  A control-plane call creates no user and no session. A management client is not a user of your app, so it lands on `c.var.controlPlane` and never on `c.var.auth` — otherwise every `requireAuth()` in every capability would pass for it.
  
  Capabilities contribute their own admin routes behind `requireControlPlane(scope)`, and those routes deny in a Worker that never composed the seam. `@pithy-sh/payments` is the first: manual entitlement grant and revoke now sit behind a real credential instead of the interim scope check they shipped with.
  
  They also **describe** those routes. `GET /control-plane/manifest` reports every composed capability with its admin routes — full path, method, and required scope — so a management client composes its calls from the Worker rather than from a route table it ships with. That matters because `basePath` is configurable: an adopter who mounts payments at `/billing` gets a manifest naming `/billing/entitlements/grant`, where a client assuming the default would have 404'd. Each route's scope against the connection's grants is what lets a client gray out what it may not do instead of discovering a 403. A capability with no management surface reports an empty list, because "composed but nothing to administer" and "not installed" are different facts. The declarations are checked against the router that actually mounted, so a manifest cannot quietly drift into lying.
  
  The minting side ships too. The seam is MIT and never gated by tier, so building your own management client against your own Worker is a real option, and `pithy dashboard connect --public-key` registers a key with no dashboard involved at all.

- [#96](https://github.com/pithy-sh/pithy/pull/96) [`1f6afb8`](https://github.com/pithy-sh/pithy/commit/1f6afb89661b03639018c6854616d8a26931d24b) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/support` — an inbound support inbox that lands mail in the adopter's own D1, classifies it on their own Workers AI binding, and links each sender to the account and purchases their app already knows about. Support is the employee a solo developer cannot hire, and every piece needed to build one was already in the catalog; nothing composed them.
  
  Mail arrives through Cloudflare Email Routing at the Worker's single `email()` entry. Support claims what is addressed to it on the SMTP envelope recipient, never on a `To:` header — anyone can put a support address in a header on a message routed elsewhere. From there the guard bounds it, `postal-mime` parses it including multipart and attachments, the HTML is sanitized through the runtime's own parser, the raw MIME goes to R2 unchanged, and the row lands in D1. Only then is classification dispatched, as a Workflow: an inbound handler has a tight CPU budget, and a model that is slow or briefly down must never take the persistence of somebody's support request with it. Threading is on `In-Reply-To` and `References`, never on the subject.
  
  Classification produces three axes from one call — category, priority, sentiment — because together they make a sortable inbox rather than a labeled one. The inference lands on the adopter's bill, and their customers' support mail never leaves their infrastructure. Model output is validated against the declared enum and falls back to `uncategorized` on a miss, because a text model always produces a plausible-sounding label and an invented one silently poisons every filter downstream. The model id and confidence are stored with every classification and the history is append-only, so a reclassification pass after a model upgrade can tell which rows came from which model. The taxonomy is federated: eight categories ship, chosen to map to action rather than topic, and an adopter adds their own with `defineSupportCategories`.
  
  Everything is derived from immutable mail. A wrong classification is recomputed, not repaired. There is no assignment and no status workflow — a status field is a state machine, and state machines attract SLAs, escalation, and reporting, which is a ticketing product and explicitly not this. Two exceptions: per-viewer read and snooze flags, which nobody coordinates around, and `archived`, one shared boolean meaning done, audited so that who marked a thread done is answerable from the trail rather than from an ownership column.
  
  Replies go out through `@pithy-sh/email`'s durable send path so they carry the adopter's domain and DKIM and set `In-Reply-To` and `References` correctly — only the Worker holds the chain, and implemented dashboard-side, threading breaks in the customer's mail client and every conversation fragments. Alongside it ships a federated catalog of canned replies: starting points a human picks, edits, and sends. They are body text rather than email templates, and nothing is ever sent automatically.
  
  `From:` is treated as a claim and stays one. Under Cloudflare Email Routing there is no sender verdict a Worker can trust — Cloudflare evaluates DMARC, since its `reply()` API requires a valid result, but does not reliably hand it to the Worker (`Authentication-Results`, `Received`, and `DKIM-Signature` are all reported missing from the delivered message), and once the MTA's own header is absent a header the sender wrote is indistinguishable from one an MTA wrote. So the match still happens — a sender resolves to an account, because that is the useful part — while the claim never does: `sender.authenticated` is false unless the adopter has set `guard.trustAuthenticationResults`, and purchases, entitlements, and the account's own `emailVerified` are withheld on an unverified match. A name beside an address is a guess an operator can sanity-check; an itemized purchase history is what somebody issues a refund on. Verifying DKIM inside the Worker is the real answer and is deliberately left for follow-up.
  
  The admin surface is `control-plane` only and default-denied, across five scopes rather than one admin flag — reading an inbox exposes every customer's private correspondence, while replying sends mail to a real person under the adopter's domain, and those are not the same permission. Listing is cursor-paginated on `(receivedAt, id)`, never offset, because mail arrives at the front of the order the list is sorted by.
  
  Search is keyword search: people look for a word they remember, not a concept. The default is an unindexed `LIKE` scan, adequate for an inbox measured in thousands of messages. FTS5 is available behind `search: { fts: true }` and is off by default for a reason worth stating — `wrangler d1 export` refuses to dump any database containing an FTS5 virtual table, failing outright rather than skipping it, and the check runs server-side across the whole database, so enabling it costs the adopter the export of every other table in their project too.
  
  The index itself is **not a migration**. It holds nothing that is not derived from `pithy_support_messages`, and `reindexThread` rebuilds it on demand, so `pithy support provision` creates and drops it to match the config — a provisioned resource like the bucket and the routing rule. That is what makes the flag safe to toggle: composing it conditionally into the migration set meant turning it off removed an already-applied migration, which Kysely reads as corruption and which blocks `pithy migrate` for **every** capability sharing the database, not just support. Until a re-provision catches up, a configured-but-absent index falls back to the `LIKE` scan rather than failing the inbox route.
  
  `@pithy-sh/email` gains three columns on `pithy_email_jobs` — `replyTo`, `inReplyTo`, and `references` — plus the enqueue inputs that set them and a `supportReply` template. They are folded into `email_0001_init` rather than added as a second migration: nothing is published yet, so an unreleased migration is code rather than a contract, and a project that has already migrated has nothing to reconcile. A column per field rather than a generic headers bag: a bag would let any caller set `Bcc` or `From` on a message the adopter's domain signs. `@pithy-sh/core` gains the six `support/*` error codes. `@pithy-sh/cloudflare`'s `CloudflareEmailRoutingManager` gains `removeWorkerRoute`, matched on the rule name rather than the address so a teardown cannot delete a rule an operator wrote by hand for the same mailbox, and its rule listing now pages to exhaustion — a truncated list reads as "no such rule", which would make provisioning duplicate a rule on every run and a teardown report mail stopped while it kept arriving. The CLI gains the catalog entry and `pithy support provision`, which creates the bucket, deploys the classification worker per environment, and creates the Email Routing rule last — creating it first would deliver real customer mail to a Worker whose classifier is not deployed yet.
  
  Cloudflare Email Routing takes over a zone's MX, so a support address belongs on a subdomain and never on the apex. That is said in the README, the manifest scaffold, and the config description, because it must be known before anything is run rather than discovered afterwards.
  
  Licensed MIT.

- [#97](https://github.com/pithy-sh/pithy/pull/97) [`c645d19`](https://github.com/pithy-sh/pithy/commit/c645d190022da1bde420d1f03c30bbd98f007234) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/testers` — the roster, the invitations, and the fourteen-day clock for the closed test Google Play makes every new personal developer account run.
  
  Twelve testers, opted in for fourteen continuous days, before production access is granted. Google says the days must be consecutive, so losing one tester on day nine effectively restarts the clock. There is no screen anywhere that tells a developer where they stand, and that absence is the whole problem this solves.
  
  **Pithy's count is an estimate from your own invite records. Google's count is authoritative and no API exposes it.** That sentence is not a disclaimer bolted on afterwards; it is the shape of the package. The Play Developer API's tester resource holds one field — a list of Google Groups — and cannot read an email roster, the opt-in count, the continuous-day streak, or a tester quietly opting out. `docs/store-apis.md` sets that out with citations, because the most valuable thing this capability can tell an adopter is what it cannot do.
  
  So the honesty is structural rather than advisory. Every figure derived from opt-in records is named `estimated`, so `estimatedHeldDays: 9` reads as a claim about our own records where `optInStreak: 9` would read as a fact about Google. The estimated half and the observed half are separate objects with literal `source` discriminators, so a developer cannot reach the number without typing the word `estimated`. The disclaimer is a required, non-nullable field on every cohort and on the envelope, so the spread-into-a-card path still carries it. `successProbability` is nullable, because "we cannot see this cohort at all" has to be representable rather than faked as a plausible 0.5 — and it is capped below one, because nothing here is ever certain. A meta-test enforces all of it, on the reasoning that the person who reads "this is an estimate" and the person who writes `if (heldDays >= 14) applyForProduction()` are the same person on different days.
  
  The clock is replayed from an append-only event log rather than stored as a counter. A counter can only be overwritten, which destroys both the old value and the evidence that it changed; replaying makes a correction an insert, and every snapshot written beforehand survives as an accurate record of what Pithy believed on that day — which is exactly what a trend chart claims to show. Only four things move a tester's state, and inactivity is not one of them: the moment a cron may lapse someone for going quiet, the count stops being a record of who confirmed and becomes a guess dressed as a record. Days are counted in UTC and the response says so, because Google's boundary is undocumented and may not be ours.
  
  **The half that is fact is activity, and it is the part nobody else has.** Because `@pithy-sh/auth` owns sessions and the device registry, a tester's invited address resolves to their user and from there to when they last opened the app. A tester dark for eight days is the one most likely to have quietly gone, and that is actionable on day eight rather than on day fourteen when the count finally moves. Activity is never treated as opt-in continuity — someone who confirmed and never opens the app still counts toward Google's twelve. Testers who never sign in report `never_linked` rather than `inactive`, and their health is `null` rather than a low score: absence of evidence is not evidence of risk, and an app whose test flow needs no sign-in would otherwise render entirely red.
  
  The forecast reports reaching the target and holding it separately, because multiplying them destroys the only actionable information in the pair — "62%" tells a developer nothing, while "you will reach twelve but hold it 65% of the time" tells them to invite four more people this afternoon. The hold half is an exact Poisson-binomial over each tester's own survival probability: deterministic, exact in the tail where the answer lives, and explainable in one sentence. The survival priors are numbers we chose rather than values fitted to anyone's data, every one of them is a config field, and the API says `calibration: "default"` out loud.
  
  A daily Workflow writes one snapshot per cohort per UTC day, and that table is what makes the trend chartable at all. The opt-in figures could always be replayed; activity could not — sessions expire and rotate, and a tester who was quiet on the ninth but active on the eleventh leaves no trace on the twelfth that they were ever quiet. Each snapshot carries its own precomputed deltas and a one-sentence trend reason, so a summary card renders from one row and cannot disagree with the chart drawn from the same series.
  
  Every nudge carries the tester's own way out, on every kind rather than only the marketing-shaped ones. A testing program repeatedly asks one person for something over a fortnight, and someone being chased must be able to stop it. Withdrawing takes a confirmation rather than a link-follow, because it rotates the tester's token and cannot be undone without a fresh invitation. Chasing also stops on its own after three unanswered messages — the cooldown bounds how often a tester is mailed, and without a ceiling on how many times, a person who never answered would have been contacted every three days for the life of the cohort.
  
  Nudges ship default copy for every kind, because a capability whose mechanism works only if you buy a dashboard is a capability that does not work. A per-tester cooldown is enforced server-side on every path including the daily pass, since a nudge trigger with no guard is a button that mails the same twelve people repeatedly. A control-plane caller may override the words and only the words: a subject and a plain-text body, wrapped in this capability's own envelope. **There is no field that accepts HTML, and that is a security boundary rather than a style preference** — supplied content goes out over the adopter's own DKIM signature, so unconstrained markup would turn a leaked dashboard credential from a disclosure problem into a phishing platform running from a domain those testers already trust. The body renders as an array of HTML-escaped paragraphs, so markup arrives as visible text structurally rather than by filtering, and the subject is stripped of control characters because the threat there is header injection instead.
  
  **A tester's journey is two emails, and the order is forced by the store rather than chosen.** A store opt-in page only works once that address is already on the tester list — and adding an address to a Play email list is precisely what the Play Developer API cannot do, so it is a manual step in the console. Sending the store link first produces `App not available`, which reads to a tester as a broken app. So the first email asks whether they will help and records their answer, `pithy testers pending` prints who is waiting to be added, and the second email carries the link once they are. That split also keeps the count honest: agreeing to test is consent, not enrollment, and counting it as one would inflate the estimate with people who said yes and never joined. `accepted` and `opted_in` are separate states for exactly that reason, and signing in to the app moves neither — that is activity, and it belongs entirely to the observed half.
  
  The store's own opt-in link is configuration rather than something a developer has to keep finding: pasted once with `pithy testers create --store-url`, frozen onto the cohort, and carried by the email. Pithy will not derive it from a package name, because Google documents no format for it. And the second link **renders** that URL rather than redirecting to it — a 302 would make the adopter's Worker a redirector, and it leaves nowhere to put the two instructions that prevent most failures: open it in a browser rather than the store app, and sign in with the address the email reached you at.
  
  The confirmation link is a high-entropy token on the tester's own row rather than a signature, on a `public` route, because a tester must be able to answer from an email on a phone with no account — requiring a sign-in would mean the one event the whole count rests on happened only for the subset willing to create an account first. Holding it in a row rather than a signature buys three things: removing a tester **revokes** their link where a signed one could only expire, no secret is read anywhere, and `pithy testers invite` therefore builds a working invitation against any environment rather than only against local dev. It is idempotent, which is a requirement rather than a nicety: email clients prefetch links and people click twice, and a second visit that re-stamped the opt-in date would reset a tester's streak on entirely ordinary behavior. An unknown token and a revoked one return identical words, so the route is not an oracle for which cohorts or testers exist.
  
  Read, write, and send are three separate control-plane scopes. A single `testers:admin` flag would mean a credential issued to read a roster could also mail every person on it, and mailing is the operation whose blast radius reaches outside the adopter's own systems.
  
  `pithy testers provision` deploys the prebuilt daily-pass Worker per environment and writes the `TESTERS_DAILY` binding the app Worker cannot write itself — wrangler demands a `name` and a `class_name` on every `workflows` entry and the deployed name is per environment, so `pithy add` emits none and this completes it. The provisioner is unusually small, and that is the point: no bucket, no index, no secret, no master key. What is left is a template, a deploy, and a binding.
  
  `pithy testers` covers the whole flow — provision, deprovision, create, list, invite, pending, roster, status, remove, close, and run — each non-interactive and `--json`, so a closed test is runnable from a terminal with no dashboard involved. `run` enqueues real mail: `enqueueEmail` writes a row into `pithy_email_jobs` and the email worker delivers it, so the CLI needs no sending domain of its own and no secret to build a link. `@pithy-sh/core` gains the eight `testers/*` error codes; `@pithy-sh/email` gains the one envelope template this capability sends everything through.
  
  Every knob in the config is read by something. `snapshotHourUtc` sets the deployed cron rather than sitting beside a schedule hardcoded elsewhere; `maxNameLength` bounds a name on the route and on both CLI paths. A `--store-url` that is not a store URL is refused where it is written rather than accepted and then silently disagreed about by the pass and the route — the disagreement mailed every tester a link that enrolled nobody while the opt-in estimate climbed on the way through.
  
  The daily pass runs one Workflow step per cohort, so a cohort that fails loses its own day rather than every later cohort's — the darkness histogram cannot be recomputed after the fact, so a lost day is lost for good. A pass re-run on a day it has already covered adds to that day's send record rather than replacing it, and a deployment with no `baseUrl` skips nudging and says so rather than throwing partway through and taking the snapshot with it.
  
  A day is corrected once it has actually ended. The pass runs at 05:00 and writes a row keyed to a day it is five hours into, so everything that happened in the other nineteen hours was missing from it — and nothing went back. The next morning's pass now replays the finished day and rewrites the opt-in half of that row, marking it `backfilled`: the clock replays exactly, the activity figures cannot be reconstructed after the fact, and that split is what `backfilled` tells a chart. Without it the stored series contradicted the replay it claims to record, and every post-05:00 opt-in plotted a day late, permanently.
  
  A closed cohort sends nothing further, on every path rather than one. `closedAt` was consulted by a single filter, so invite, resend, nudge and `run --cohort` all carried on mailing a finished program. The chase cap is the same shape: three unanswered messages stopped the daily pass and nothing else, so a dashboard could chase an unresponsive address every three days for the life of the cohort. Both are now enforced where every path converges.
  
  **A withdrawal is the tester's own decision, and it is durable.** `lapsed` has exactly one producer — the opt-out route the tester followed themselves, having been shown a page that says they will not hear from the test again — so unlike `removed` it is never a state the developer chose. Re-inviting a withdrawn address is refused. Every other send path already refused one; `invite` was the exception, it sends by default, and it is the path a routine contact-list re-import takes. Removing a tester stays reversible, because that is the developer's own act on their own roster and undoing it takes nobody's consent away.
  
  Write scopes do not confer read. The three control-plane scopes exist so a management client can mail or manage a roster it was never granted permission to read — the nudge preview returns ids rather than addresses for exactly that reason, and `resend` and `remove` now do the same. The address still reaches the audit trail, which is where it belongs.
  
  Licensed MIT.

- [#103](https://github.com/pithy-sh/pithy/pull/103) [`c58405e`](https://github.com/pithy-sh/pithy/commit/c58405ef35bf57cbd0ddf70c5f8651bba90d6b4f) Thanks [@kingmesal](https://github.com/kingmesal)! - Everything between the control-plane seam and a management client that can actually address a project and read something from it.
  
  **A Worker's address is declared once.** `domains: { prod: { pattern, zone } }` in a Worker's own `pithy.config.ts`, per environment, and the `routes` entry with `custom_domain` and `vars.BASE_URL` are generated from it. Three commands used to reconstruct that address three different ways — `pithy env` scraped the first route, `email provision` and `turnstile` read a hand-set `BASE_URL`, and `deploy` scraped whatever URL wrangler last printed — and nothing noticed when they disagreed. One resolver replaces all three, preferring the declaration, falling back to a route and then to the var, so a project that predates this keeps working and is never told to migrate. `pithy init` and `pithy worker add` ask for it against the account's **real Cloudflare zones**, so a typo fails at `init` with a list of what exists rather than at `deploy` with a Cloudflare error to decode; the prompt is skippable, and it degrades to free text when the account is unreachable.
  
  **`pithy deploy` proves the Worker it shipped is the one answering.** `GET /health` now reports the running build, and deploy probes the *declared* domain and asserts the version matches what it just shipped. A liveness check would not catch the failure worth catching — the old version answering happily at the declared domain while the deploy landed somewhere else. It retries through propagation, and reports a gradual rollout as inconclusive rather than failed.
  
  **`CF_VERSION_METADATA` is finally bound.** The logger has always read it and `docs/LOGGING.md` has always documented it, but no template declared the binding, so the `version` field was absent in every scaffolded project and nobody could correlate a log line to the deploy that produced it. Both scaffolds now emit it, `pithy upgrade` adds it to an existing project, and a parity test holds the two generators together — two unsynchronised producers is *how* it went missing. The id reaches five consumers: every log record, every audit event, the control-plane manifest, a `pithy-worker-version` header on every control-plane response, and the deploy check.
  
  **The manifest reports both version axes.** The Cloudflare build id says *which build* — the answer for forensics. The composed `@pithy-sh/*` versions, per capability and never aggregated, say *which features* — the answer for "should this customer upgrade" and "who is exposed to what we just fixed". A Worker cannot read its own `package.json`, so each package's version is stamped into a committed constant with a CI check against drift.
  
  **Registration is self-sufficient.** `pithy dashboard connect` resolves the Worker URL itself instead of demanding `--worker-url`, names its Worker and refuses ambiguity in a multi-Worker project, and sends the seam's `basePath` — the one address a client cannot discover, because it *is* the manifest's address. Without it an adopter who mounted the seam at `/admin` registered cleanly, passed the ping at the assumed path, and then 404'd on every call.
  
  **Admin routes on the capabilities that shipped before the seam.** `@pithy-sh/auth` (find and read users with sessions and devices; revoke a session, sign a user out everywhere, revoke a device — no impersonation), `@pithy-sh/audit` (page the trail, read one event in full), `@pithy-sh/email` (jobs by status and in detail, retry, the suppression list), `@pithy-sh/ledger` (balances and history, read-only). Least-privilege scope per operation, audited including reads, keyset pagination on every list through one shared core helper, and each declaration drift-tested against the router that actually mounted.
  
  **The replay guard holds.** A control-plane token is now spendable exactly once, claimed with `INSERT … ON CONFLICT DO NOTHING` on the `jti` primary key — strongly consistent, wherever the requests land. The KV guard it replaces had no compare-and-set and was eventually consistent across colocations, so a replay arriving at a different colo inside the propagation window passed. Narrow is not harmless: a nudge sends real people a second email. KV stays selectable behind the same interface with the race stated; the D1 default needs no KV namespace at all.

- [#232](https://github.com/pithy-sh/pithy/pull/232) [`67d2cc4`](https://github.com/pithy-sh/pithy/commit/67d2cc4633f0fd66e328092e2aabce1dead48713) Thanks [@kingmesal](https://github.com/kingmesal)! - A `pithy.config.ts` with two syntax errors stops classifying worse than one ([#223](https://github.com/pithy-sh/pithy/issues/223)).
  
  [#207](https://github.com/pithy-sh/pithy/issues/207) taught a config that will not load to name its own cause: a missing dependency says `bun install`, a
  stray brace says where the file is broken. It worked for a file with **one** diagnostic. Bun hands one
  diagnostic over bare and **two or more inside an `AggregateError`**, and a stray brace cascades — a single
  missing `}` produced four — so the shape [#207](https://github.com/pithy-sh/pithy/issues/207) fixed is the rarer one. The wrapper's `Object.keys` is empty
  and its message is `4 errors building "<path>"`, which matched nothing the classifier looks for, so the
  commonest syntax error in the world fell through to *the config threw while loading, run the file
  directly*. The line and column were in hand and thrown away.
  
  ```
  Before:  The config threw while loading. Run the file directly to see what it throws.
  After:   The config does not parse: Expected identifier but found ";". Line 4, column 1.
           Fix the file — installing dependencies will not help.
  ```
  
  **The second import of the same broken file is a different error again**, and that one is what
  `pithy doctor` renders. Bun caches a failed module and re-throws the wrapper with its `errors` gone —
  count and path, nothing else — so unwrapping cannot help, and `doctor` loads the root config twice by
  design, because resolving the project's Cloudflare account ([#206](https://github.com/pithy-sh/pithy/issues/206)) reads it before the report does. The
  wrapper's own message is enough to know a build ran and produced diagnostics, so it is named a parse error
  with no reason and no position rather than mis-blamed on the config's runtime. Nothing else degrades this
  way: a `ResolveMessage`, a bare `BuildMessage` and a config's own `Error` are identical on every import.
  
  `@pithy-sh/core` gains `src/error/cause.ts` — `rootCause`, `isBuildFailureWrapper`, and the duck-typed
  `prop` both are built on. Three classifiers read this failure (`cli`'s `classifyConfigLoadFailure` and
  `classifyCapabilityLoadFailure`, and `vite`'s `classifyWorkerConfigFailure`, which restates the first
  because the plugin must not depend on the CLI), and all three had got the same runtime wrong. What they
  share now is **what Bun does to an error on its way out** — a fact none of them can derive locally, and
  the only part they cannot be allowed to disagree about. The refusals stay their own; they are not the same
  sentence and never were. `@pithy-sh/vite` still depends on `@pithy-sh/core` alone.
  
  Nothing an adopter can read changed shape at the boundary [#207](https://github.com/pithy-sh/pithy/issues/207) drew: `message` is still exactly
  `Could not load <path>.`, and `action` still carries no newline, no ANSI escape, no stack frame and no
  absolute path — asserted per cause, wrapper included, because a build diagnostic is a multi-line colored
  box quoting the file.
  
  [#207](https://github.com/pithy-sh/pithy/issues/207) survived its own Bun testing because the repro used one deliberate typo. The suite now spawns Bun,
  imports a config missing one brace, and asserts the wrapper it really gets — twice, so both shapes are
  pinned. A Bun that stops wrapping fails that test instead of silently restoring this bug.

- [#102](https://github.com/pithy-sh/pithy/pull/102) [`5668f08`](https://github.com/pithy-sh/pithy/commit/5668f0874a8df0fa9ad8477f3e1b48b46c181054) Thanks [@kingmesal](https://github.com/kingmesal)! - Every audit event now records the project, environment, and Worker it came from, so a shared database and an exported log both stay attributable.

- [#37](https://github.com/pithy-sh/pithy/pull/37) [`a4ab423`](https://github.com/pithy-sh/pithy/commit/a4ab423f07fd8d77061930c602444d5e9562d208) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add <capability>` now installs the package, wires your config and bindings, and runs its migrations in one step — you pick the mount path, the handlers stay in the package.

- [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5) Thanks [@kingmesal](https://github.com/kingmesal)! - Seed any test environment from your own Zod-typed fixtures — local or live — with `pithy seed`. Author a `defineSeed` set once and it composes library-before-app, exactly like a migration, validating every row against your real table schemas before a single insert runs. D1 and KV writes are idempotent and never destructive; media assets upload to Images or Stream once and record their UUID for every run after. Production stays opt-in twice over: a set must list it explicitly, and the command still refuses without an exact confirm phrase.

- [`288848e`](https://github.com/pithy-sh/pithy/commit/288848e849f2aadf1f9444b3db03d94b781a0e1b) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy migrate --env` now promotes migrations to staging and production over the D1 API, and `pithy deploy` ships your Workers to Cloudflare — both runnable by hand or in CI. The migration bookkeeping tables move to `pithy_migrations` / `pithy_migrations_lock` so they never collide with an adopter's own Kysely migrations.

- [`d74ce14`](https://github.com/pithy-sh/pithy/commit/d74ce140f5c19848eb7415d6b6ee86815107f83c) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy remove <capability>` cleanly reverses `add` — unwiring config and bindings and uninstalling the package — leaving your data untouched unless you opt in with `--drop`. It is a manual, interactive-only command.

- [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy seed --redo` rebuilds an environment's data from scratch: roll every migration back, run them all forward again, then seed. Seeding is deliberately non-destructive — D1 is `INSERT OR IGNORE`, KV skips an existing key — so editing a fixture's values and re-seeding silently did nothing. `--redo` is the way to make edited fixtures actually land. Because the schema comes back empty, the ordinary writes just work.
  
  **It is destructive: every row in every table the migration registry owns is gone, hand-inserted data included.** So it carries its own gate, stricter than the seed gate. `--yes` means "this is not dev" and was designed to authorize an additive write; it does not authorize a drop. Any non-`dev` reset needs the exact phrase `yes, i really want to reset <env>`, passed as `--confirm-reset` or typed at a prompt that states the loss first. The phrase names its environment, so one env's cannot be pasted at another. `dev` stays free. CI still automates it by passing the flag. Every reset is audited before the drop begins, at `critical` severity off `dev`.
  
  Adds `resetMigrations` to `@pithy-sh/core`, and `resetProject`/`previewReset` to the CLI's migration layer — the same plan and driver as `migrate`, so a reset works against local Miniflare and remote D1 alike.

- [`af1871b`](https://github.com/pithy-sh/pithy/commit/af1871b7e467d4e69e287038deaa0023e9c94ac3) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy token mint` creates scoped, least-privilege, account-owned Cloudflare API tokens for each job and stores them where you point it — no hand-crafting tokens in the dashboard. One `ci-system` credential covers your CI pipeline and grows as capabilities declare what they need; worker-consumer tokens (like the secrets manager's) land in the CF Secrets Store. Mint, list, rotate, and revoke, all non-interactive and `--json`.

- [#36](https://github.com/pithy-sh/pithy/pull/36) [`e92a9a0`](https://github.com/pithy-sh/pithy/commit/e92a9a0d3658745909e36d7d4c42a53716351653) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/cloudflare` — one encapsulated client for every out-of-Worker Cloudflare operation. Adds the `cloudflare/*` error codes to the core error taxonomy.

- [`535755a`](https://github.com/pithy-sh/pithy/commit/535755a799a16e290b745eb18cf50aba6113bbbe) Thanks [@kingmesal](https://github.com/kingmesal)! - The Capability contract and AuthContext seam — the single interface every capability composes through.

- [`a9fe34f`](https://github.com/pithy-sh/pithy/commit/a9fe34f7d3a1ec4bb881de3604b0f37d7ebcf982) Thanks [@kingmesal](https://github.com/kingmesal)! - CapabilityManifest schema — the declarative description the CLI reads to wire a capability.

- [`f238b0a`](https://github.com/pithy-sh/pithy/commit/f238b0a63d16608bf203ffc763f800f29d535a80) Thanks [@kingmesal](https://github.com/kingmesal)! - Config loader and fail-fast binding validation — compose and validate capability config, and reject a Worker that's missing a required binding.

- [`b22db91`](https://github.com/pithy-sh/pithy/commit/b22db91d2dcd39b4c95bd53f082c98e5df952fff) Thanks [@kingmesal](https://github.com/kingmesal)! - createBackend — the Hono app factory that assembles capabilities into a deployable Worker, serving /health with fail-fast binding validation.

- [`0ad7c74`](https://github.com/pithy-sh/pithy/commit/0ad7c744a8898824e1dc9de075afec7dd81f079a) Thanks [@kingmesal](https://github.com/kingmesal)! - Namespaced migration registry — merges every capability's migrations into one stable, deterministically-ordered run, so upgrades add migrations without renumbering.

- [`4b57172`](https://github.com/pithy-sh/pithy/commit/4b57172c27bf872d751f1bbe48eff412aedb9c02) Thanks [@kingmesal](https://github.com/kingmesal)! - `@pithy-sh/core`: `runMigrations` and `rollbackMigration` — the per-database Kysely migration runner, tested against real D1.

- [`2811006`](https://github.com/pithy-sh/pithy/commit/2811006b836a63d56002e0858ec6db697698807e) Thanks [@kingmesal](https://github.com/kingmesal)! - Per-database migration runs. `createMigrationRegistry` now produces one ordered migration provider per database — matching multi-database D1 — with stable keys and core-before-app ordering preserved per database.

- [`d42946d`](https://github.com/pithy-sh/pithy/commit/d42946d4ad2c6b78240fb99f29fb85dc5ff30ae2) Thanks [@kingmesal](https://github.com/kingmesal)! - Typed SQLite codecs: booleans, dates, and validated JSON convert to and from D1 storage automatically.

- [`309a384`](https://github.com/pithy-sh/pithy/commit/309a38476c57f4d33e01f67cc08f06436bf292e2) Thanks [@kingmesal](https://github.com/kingmesal)! - New in `@pithy-sh/core`: a two-mode `Logger`. Mode one unifies local CLI and Worker diagnostics — human-readable, or `--json` for agents. Mode two emits structured, request-correlated records with Cloudflare Workers Logs on by default and a tail/Logpush hook. Capabilities resolve `c.var.log` instead of calling `console`, and the `@pithy-sh/audit` recorder now logs through it.

- [`5dc508a`](https://github.com/pithy-sh/pithy/commit/5dc508a20d19c6e03beca35b799df8df9e772252) Thanks [@kingmesal](https://github.com/kingmesal)! - Typed `db` and `kv` registries on the request context. Capabilities register D1 databases and KV namespaces; createBackend merges them per binding into typed accessors — `c.var.db.<database>` and `c.var.kv.<namespace>.<store>`. Multiple databases and namespaces coexist, composed from capability slices. No central schema file.

- [`241ce03`](https://github.com/pithy-sh/pithy/commit/241ce0371d16cd9883ac7fdb7badc04247ca3a04) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy now speaks one language for failure: a typed `PithyError` with machine-readable codes that render straight to HTTP or the terminal.

- [`fdba68c`](https://github.com/pithy-sh/pithy/commit/fdba68c1daffe094d566b0f37ba305ca2f715f85) Thanks [@kingmesal](https://github.com/kingmesal)! - Typed KV access and the Kysely D1 database builder.
  
  `TypedKv` — validated reads and writes over structured, namespaced keys: prefix-range `list`, size-bounded metadata (optionally derived from the value and self-healed when an external edit drops it), and partial-update `patch`. `createDatabase` — Kysely over D1 with the mandatory CamelCasePlugin, so camelCase queries map to snake_case columns.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - Press `l` to open a signed-in browser, instead of pasting a cookie
  
  `pithy dev` no longer prints a session cookie. The ready banner used to hand over a live credential as text —
  `document.cookie = "better-auth.session_token=…"` — to paste into a browser console. A working session token
  rendered on a terminal is a working session token at rest, in a scrollback, in `logs/dev.log`, and in every
  screenshot of either. The seed already flagged that artifact as sensitive; printing it was the one place the
  rule was suspended by design.
  
  Now the banner names the user and offers a keypress: `Dev login: ada@example.com — press l to open a signed-in
  browser.` Pressing `l` opens `http://localhost:<port>/__pithy/dev-login` in whatever browser is default. The
  Worker sets the cookie and redirects to `/`. The value travels from the Worker to the browser and lands
  nowhere else.
  
  `@pithy-sh/auth` registers that route behind **two independent gates, both at registration**: the composition's
  `ENVIRONMENT` must be `dev`, and `CI` must be unset or blank. A route that mints an authenticated session with
  no credential presented cannot be allowed to reach staging or production, and CI runs `dev` compositions
  constantly, so neither gate implies the other and neither is folded into the other. A `staging` composition, a
  `prod` composition, and a `dev` composition under CI each carry no such route at all.
  
  `CI` is now read in one place, `@pithy-sh/core`'s `env/ci.ts`, with `PITHY_OFFLINE`'s rule: any non-blank value
  is set, blank is no override. `pithy dev` forwards it into each Worker as a var, because the host environment
  does not otherwise cross into workerd.
  
  A non-TTY `pithy dev` — CI, a pipe, `--json` — never enters raw mode and never waits for input; the banner
  prints the URL instead. `l` with no seeded session says so and names `pithy seed` rather than opening a URL
  that 404s. A project where several Workers compose auth prints the choices instead of guessing which origin
  to sign in on.

- [#48](https://github.com/pithy-sh/pithy/pull/48) [`e5b8a60`](https://github.com/pithy-sh/pithy/commit/e5b8a6072612d8e0a331833c0bc6e2b7c86b9ce4) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/email` — D1-backed email jobs with immediate, scheduled, and per-timezone sends, themeable Handlebars templates, and built-in open/click/bounce/unsubscribe tracking.

- [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy feature` stands up a branch's isolated environment in one command each — `create` for a seeded local backend, `provision` for its live Cloudflare one, `destroy` to tear it all down. `create` (local, automatic) cuts the `feature/<issue>-<slug>` worktree, reserves a non-overlapping port block and pins one port per worker into the worktree's `.dev.config.json` — fixed for the life of the feature, so N features run at once with no startup race for a free port and every worker has a stable address to wire to — links `.dev.vars` to the repo's one shared secrets file, and migrates + seeds the local Miniflare backend. `sync` (run from the worktree, no arguments) makes an existing worktree ready whatever state it is in: it gives a newly added worker the next free port from the feature's own block without moving any existing worker, and — for a colleague who just pulled the branch — creates the whole machine-local setup (`.dev.config.json`, a port reservation on their machine, the `.dev.vars` links) and migrates + seeds their local backend. `provision` (remote, explicit, run from the worktree) creates one ephemeral CF resource per binding the enabled capabilities declare — named under a branch-first `<project>-f<issue>-<slug>-<resource>` prefix — records each id in a per-feature manifest, writes them into `wrangler.jsonc`, then migrates + seeds; it is idempotent and resumable, so an interrupted run picks up where it left off. It also gives every Worker its environment-scoped script name and retargets each `service` binding at the feature's own deployment, so worker-to-worker RPC in a feature environment stays inside that feature instead of reaching production. Because every name derives from the branch, CI recomputes the same wiring on each push and recovers already-provisioned ids by name — none of it has to be stored or committed. `destroy` deletes the manifest's resources, reconciles the feature's expected names, frees the port block, and prunes the worktree the Linux-safe way. All three run non-interactively with `--json`. Adds KV-namespace and R2-bucket control-plane provisioners (and a D1 `listDatabases`) to `@pithy-sh/cloudflare`, and a `service` target field to `BindingSpec` in `@pithy-sh/core`.

- [`5d69fb5`](https://github.com/pithy-sh/pithy/commit/5d69fb57c06d6a8d28a2bce43ccc3cf6e0c04097) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/leaderboard` — rank your players on your own Cloudflare account. Submit a score, read the standings, read your own rank, daily through all-time. One store, always: D1. There is no engine flag, because a Durable Object bills rows exactly as D1 does, adds request and duration billing D1 lacks, and is single-threaded with the same 10 GB cap — so it fixes neither cost nor hot-board serialization. Scale is a cadence dial, and the dial is pure D1. A board definition is the unit of config: `direction` (immutable), `aggregation` (`best` | `latest` | `sum`), and an optional CRON `window`. Retention defaults to keep-all — storage is never the cost driver, so nothing is deleted unless a board sets `retain` (keep the newest N closed windows, a product limit) or `retainDays` (delete data older than N days, a compliance limit); the two are mutually exclusive per board. CRON rather than a fixed enum is what makes calendar months and years expressible — Apple caps recurrence at 30 fixed days and Google ships no monthly at all. Entries are keyed `(board, window, player)`, so each window carries its own aggregation state. Ties break by earliest `achievedAt` then `userId`, making the ordering total — so dense-vs-competition ranking never arises and neither is implemented. `rank: "live"` is the default: correct, no moving parts, and $0 under ~10k players; `rank: { materialize: <cron> }` stores the rank and refreshes it in keyset-walked chunks bounded by D1's 100-bound-parameter cap and 30-second query limit, which is the documented path past ~100k players. The refresh runs as a cron-triggered Cloudflare Workflow that checkpoints the keyset cursor per batch — a board of any size ranks across as many durable steps as it needs and resumes from the last checkpoint on a crash, so there is no per-run entry ceiling. It needs a cron trigger but not a dedicated worker; it can be folded into the app worker, and stays inside Cloudflare's free Workflow allowances at any realistic cadence (all state is D1, awaiting steps burn no CPU). A D1 advisory lock (`pithy_leaderboard_locks`) serializes refreshes: if a cron fires again while one is still running, the second instance cannot take the lock and skips, so two passes never interleave their chunked writes into an incoherent rank set; a crashed instance's lock ages out and is reclaimed by the next fire. Ranking uses no window functions — `RANK() OVER` is undocumented on D1, and a Miniflare pass is not evidence about production — and a query-plan test reads D1's own `EXPLAIN QUERY PLAN` to prove the ranking index is chosen. Writes are server-authoritative by default, inverting the vendor norm: a submission needs the board's submit scope and carries a score and nothing else, with the player from the AuthContext seam and the timestamp from the server. Per-board `min`/`max` bounds, player-controlled visibility, and a moderator hide/remove API are the anti-cheat baseline; friends/segment views and tiers are dimensions over the same store, not second boards. Read-your-own-writes rides the D1 Sessions API on an `x-pithy-d1-bookmark` header, so replication lag never hides a player's own submission. Editing a board's immutable fields after entries exist fails with `leaderboard/board_immutable` rather than silently reinterpreting stored scores. Each board carries an immutable `store` discriminant (`"d1"` today, enforced by the same drift guard as direction/aggregation/window) so a future column-oriented, approximate board type can be added per board without disturbing exact D1 ranking. A per-board `trackActivity` flag (default off) guards non-improving `best` submissions to zero rows written — the capability's largest cost lever, since submission writes dominate the bill; setting it true keeps `submittedAt` a true last-seen timestamp at full write cost. The entries table uses a plain `INTEGER PRIMARY KEY` rather than `AUTOINCREMENT`, measured to save a `sqlite_sequence` write on every upsert and keep guarded no-ops truly free. Both submission writes and the materialize refresh write are priced from D1's own `meta.rows_written` (a submission writes 2, a rank-only refresh 1), and the board drift guard re-reads the winning record on the first-submission path so a divergent definition cannot slip through a concurrent insert. Every route declares a verification strategy and is auth-gated; runtime throws `leaderboard/*` errors. Ships a reproducible, test-pinned cost model (`bun run --filter @pithy-sh/leaderboard costs`) whose write figures are measured against D1's own `meta.rows_written`, `docs/costs.md`, and the vendor comparison at pithy.sh/docs/capabilities/leaderboard/differentiation — an honest cross-vendor price comparison (the free platform SDKs and PlayFab are cheaper; the trade is cross-platform reach and adopter-owned data). Licensed MIT.
  
  `@pithy-sh/core` gains the six `leaderboard/*` members of the `ErrorPayload` union. `@pithy-sh/cli` corrects the leaderboard catalog rationale.

- [`d60788a`](https://github.com/pithy-sh/pithy/commit/d60788ac98e4317368156bdac438cebd621788a2) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/ledger` — a per-user balance ledger for whatever an app's economy runs on (chips, gold, gems, credits), currency-agnostic, in your own D1. Correctness is enforced by the database, not by hopeful application code: every movement is a single `DB.batch` (atomic — the ledger entry and the balance change commit together or not at all), idempotent on a caller-supplied `ref` written as a `UNIQUE` row (a payout delivered twice pays once), and overdraft-safe by a `CHECK (balance >= 0 AND held >= 0 AND held <= balance)` on the account (a debit or hold past solvency aborts its transaction, even against a balance a concurrent operation just lowered — no race slips past SQLite). Statements are built with Kysely (so `CamelCasePlugin` owns the columns and reads go through the codecs) and compiled into the batch. Operations are credit, debit, atomic transfer, and the wagering primitives — hold (reserve a stake), release (return it), capture (spend it) — which is what makes betting safe, so it pairs with `@pithy-sh/multiplayer`. Amounts are integers in the currency's minor unit, never floats. It takes no position on whether the units map to money, or the regulation that implies — that is the adopter's. A thin HTTP surface lets players read their own balance and history; moving another player's funds is server-authoritative and needs the `ledger:admin` scope. `core` gains the `ledger/*` error codes; the CLI adds it to the capability catalog. Licensed MIT.

- [`532e438`](https://github.com/pithy-sh/pithy/commit/532e4381fe863d723734cb16841411d5d7541c52) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/multiplayer` — authoritative, turn-based multiplayer sessions on your own Cloudflare account, and Pithy's first Durable Object. The one thing a relay cannot do: the server holds game state no client can be trusted with, resolves it, and writes a durable result to your D1. A session is game-agnostic — membership bound to an authenticated user (never client-asserted), a lifecycle, hidden per-player state, an alarm-driven deadline (never a timer, so the object hibernates between turns), the WebSocket Hibernation API, and a one-way publish of results to `@pithy-sh/leaderboard`. What a game *is* lives behind a `GameModel` seam resolved from a registry by `kind`. On top of it, three reusable pattern helpers own the lifecycle plumbing — `simultaneous` (collect one hidden submission per player, resolve together), `turnBased` (turn order and advancement), and `wageringTable` (a persistent casino table's bet book, holds, and settlement) — and three example games ship layered on them: `battle` (secret simultaneous moves; an offense scores unless any opponent blocked it, a duel or an N-player free-for-all), `connect-n` (tic-tac-toe, Connect Four, gomoku in one config), and `craps` (pass/don't-pass/field, come-out and point phases, shooter rotation). Adopters register their own game the same way. It also provides a wagering stack: provably-fair randomness (a per-session crypto seed committed by SHA-256 up front and revealed at the end, feeding a deterministic dice/shuffle stream the DO advances and persists — an auditor can replay every roll); a persistent `table` mode where players buy in and cash out between rounds; and a wager seam where a pure model *declares* ledger effects (hold a stake, capture a loss, credit a win) that the DO settles through `@pithy-sh/ledger` before the state commits, so a stake a player cannot cover rejects the action and a deterministic model's stable refs make a replay pay once. It is not rooms, chat, presence, or real-time action netcode — Cloudflare's PartyServer ships those. `core` gains a `durable_object` binding type and the `multiplayer/*` error codes; the CLI wires the DO namespace binding and its `new_sqlite_classes` class-migration tag into `wrangler.jsonc` for every environment on `pithy add multiplayer`, and reverses both on remove. Licensed MIT.

- [#57](https://github.com/pithy-sh/pithy/pull/57) [`24ae9cd`](https://github.com/pithy-sh/pithy/commit/24ae9cd339894399b424506902bcf7076ff6530b) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/audit` — a D1-backed, queryable audit trail with a core emit seam and a CLI companion emitter, so both Workers and CLI commands record who did what, when, and whether it succeeded — attributed to the right CF actor. Core gains the `emit()` audit seam, the `audit/*` error codes, and the shared `withD1Retry` helper; `@pithy-sh/cloudflare` gains a user/token identity reader for actor resolution.

- [#83](https://github.com/pithy-sh/pithy/pull/83) [`b84ec9e`](https://github.com/pithy-sh/pithy/commit/b84ec9ec2b785d4756067f6fdc8c4780bf978e1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add react` scaffolds a React 19 front end into a Worker and wires it end to end — HMR against real bindings in dev, one origin in production, and passwordless sign-in already working when auth is composed. Every route Pithy provides now declares its params, query, and body on the route itself, validated by one mechanism.
  
  Two edges change what a caller sees. Free-form params — `userId`, invite `id`, room `code`, media and session ids, email tokens — are now shape-checked and can answer 400 where they previously reached a store. And a validator on the route line runs before the handler, so a request that is both malformed and unresolvable now returns 400 where it used to return the domain's 404.
  
  One more is a behavior change worth knowing about: a **repeated** query parameter is now a 400 on any validated query. `?window=a&window=b` previously resolved to one value silently; `@hono/zod-validator`'s `query` target hands the schema an array, which a scalar field rejects.
  
  Two more become correct rather than merely different. A body Hono cannot parse at all is now a 400 instead of a 500. And `turnstile()` reads the response token off a clone of the request, so a request that passes the humanity check still reaches the handler behind it — previously the gate consumed the body and only worked when it denied.

- [#100](https://github.com/pithy-sh/pithy/pull/100) [`0bb29e2`](https://github.com/pithy-sh/pithy/commit/0bb29e26617e3003ea1229415b623e0bb658f205) Thanks [@kingmesal](https://github.com/kingmesal)! - Every resource, secret, and token Pithy provisions is now named for your project, so two projects in one Cloudflare account can never quietly share — or destroy — each other's data.

- [#55](https://github.com/pithy-sh/pithy/pull/55) [`3c011eb`](https://github.com/pithy-sh/pithy/commit/3c011eba0febe0f9c2a179388e48905beae17e1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Secrets are now resolved once per worker invocation and shared across all capabilities, cutting redundant Secrets Store round-trips.

- [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5) Thanks [@kingmesal](https://github.com/kingmesal)! - Example seeds now come as a connected cast. `@pithy-sh/core` exports `EXAMPLE_IDENTITIES` — three canonical test users — and each capability's `example` seed set references them: `auth` seeds the users, `leaderboard` their scores, `ledger` their balances, `multiplayer` a match between them, and `audit` a timeline of security events attributed to them (for the dashboard). Turn on `seed.includeExamples` and a fresh backend comes up with the same three people owning connected data across every table, not scattered rows. Each capability reads the ids from core, never from another capability, so the cast couples nothing.

- [#53](https://github.com/pithy-sh/pithy/pull/53) [`3a65e71`](https://github.com/pithy-sh/pithy/commit/3a65e71641d23d34a73d0b73128c7c02f0e65410) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/turnstile` — stackable humanity-check middleware plus automated CF widget provisioning, with test keys wired automatically in dev and staging. Core drops `turnstile` from the `VerificationStrategy` union (it is composable middleware, not an identity strategy), adds the `turnstile/*` error codes, and gains a `dependsOn` peer-capability seam enforced at `createBackend` assembly. `@pithy-sh/cloudflare` Turnstile widget creation takes a mode (managed/invisible); the `pithy turnstile` command provisions and tears down widgets.

### Patch Changes

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` writes every option the capability requires.
  
  `pithy add` renders one `key: default` per manifest option, and a manifest could only state a JSON scalar. `SecretsConfig.registry` is neither optional nor a scalar, so no manifest could declare it and `pithy add secrets` wrote `secrets({ rotationIntervalDays: 30 })` — a registration missing a required property. `bun run typecheck` on a freshly scaffolded project then failed `TS2741` before the adopter had touched a file, and secrets is the first capability most projects add, because auth, email and payments all read their credentials through it.
  
  An option's manifest value may now be an empty object or an empty array, and `@pithy-sh/secrets` declares its `registry` as one. The contents stay the adopter's — `add` cannot invent a secret — but the key is present, the config compiles, and the comment above it says what belongs inside. `pithy upgrade` reports and writes the same option into a project that composed secrets before this. Neither `--set` nor the interactive prompt will touch such an option: both carry strings, and a registry is not a string.
  
  `scaffoldGates.test.ts` now runs `pithy init` → `pithy add secrets` → `tsc -b` against a real scaffold, which is the sequence that was never run end to end.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` seeds a worked example where an empty one would not load.
  
  Three capabilities still left a project that could not typecheck. `ledger` omitted `currencies`, `multiplayer` omitted `games`, and `leaderboard` omitted `boards` behind a `serverAuthoritative` defaulted to the string `"true"` against a boolean field. All three failed `tsc` on a scaffold the adopter had not touched.
  
  [#161](https://github.com/pithy-sh/pithy/issues/161)'s empty literal is the wrong fix here, and that is the whole of this change. Each of the three puts `.min(1)` on its collection with a message saying why — *"A ledger with no currencies does nothing."* An empty seed compiles and then throws `too_small` on the first config load, which `pithy upgrade` reports as "Could not load pithy.config.ts / Install the project's dependencies". That names the wrong cause and is worse than the type error it replaced.
  
  So a manifest default may now be a complete, minimal, working example, and each of the three states one. `ledger` seeds `chips` — one currency, the schema's own first example of a unit that is plainly not money. `leaderboard` seeds an all-time board where the highest score wins: the smallest board that works and the one shape that needs no rank worker. `multiplayer` seeds tic-tac-toe — the built-in `connect-n` model on a 3x3 board, two players, no wagering — the smallest game that actually plays. The comment above each says to replace it. The adopter edits one line instead of inventing a shape from a type error.
  
  `ConfigOptionValue` widens to any JSON value but `null`, stated recursively rather than as `unknown` contents, so a null buried three levels down is now rejected instead of rendered into someone's config file. Rendering is no longer `JSON.stringify`: that quotes every key, and Biome rewrites `{"code":"chips"}` to `{ code: "chips" }` and fails the scaffold's own lint gate. `renderConfigValue` prints the shape Biome would have printed, on one line.
  
  Each of the three capabilities now checks its own manifest against its own factory — the rendered options are type-annotated, so a shape the factory would reject fails the compile, and the factory call is what proves the seed survives the `.min(1)`.
  
  All fifteen addable capabilities now go `pithy init` → `pithy add` → `tsc -b` → `biome check` clean, and fourteen of them load the config they were written into. `multiplayer` is the exception, for an unrelated reason: its entrypoint re-exports the Durable Object, so importing its config outside workerd fails on `cloudflare:workers`. That is its own defect.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - One renderer for a manifest default, one gate for the line it lands on.
  
  [#168](https://github.com/pithy-sh/pithy/issues/168) replaced `JSON.stringify` with `renderConfigValue` so a generated `pithy.config.ts` would already be in the shape Biome prints. It replaced one of two. `pithy upgrade` kept its own copy, so the same manifest produced `[{ code: "chips", name: "Chips" }]` from `pithy add` and `[{"code":"chips","name":"Chips"}]` from `pithy upgrade` — and only the first survived the `biome check` a scaffolded project runs on itself. Both commands now render through `renderConfigOptionLine`, which is the whole line and not just the value, and a test asserts the two commands agree rather than asserting a string. That is what stops a third producer.
  
  The one-line rule was a docstring. Biome breaks any literal past 120 columns and explodes it across a dozen lines, which fails `biome check` on a project the adopter has not touched — the defect [#161](https://github.com/pithy-sh/pithy/issues/161) and [#168](https://github.com/pithy-sh/pithy/issues/168) were both about. Nothing checked it, and the margin was thinner than it looked: multiplayer's seed is 98 columns of 120, and a `battle` game with a two-move catalog reaches 135. It is now a test over every manifest the repo ships, rendered at the indent the writers really use. A sixteenth capability with an oversized seed fails the build instead of an adopter's first `bun run lint`.
  
  `ConfigOptionValue` narrows rather than the renderer growing a copy of Biome's formatter. Three shapes the widened type admitted did not print the way Biome prints: `he said "hi"` renders with escaped quotes where Biome writes `'he said "hi"'`, `1e21` renders as `1e+21` where Biome writes `1e21`, and `"${x}"` renders valid TypeScript that trips `noTemplateCurlyInString`. The alternative was to carry a quote-preference heuristic and a numeric-literal normalizer, and keep both in step with a formatter free to change either — for inputs no worked example should carry. A manifest default is an example; one needing a quote inside a string is already too clever. The schema refuses all three, and `renderConfigValue` refuses them too, so `pithy add --set` fails at the command rather than writing a file that fails the lint gate later.
  
  The test that asserted the escaped-quote rendering as correct is corrected. It pinned a violation of the function's own stated contract, which would have made the fix look like a deliberate assertion being deleted.
  
  Every case above was checked by writing the rendered output to a file and running Biome over it with the scaffold's own `biome.jsonc`. The whole defect class here is guessing what Biome would print.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A seed group sizes itself against D1's bound-parameter cap.
  
  `seedD1Group` bound every row of a group into one statement. D1 accepts 100 bound parameters, and an insert binds one per column per row, so the real ceiling was about fifteen rows on a seven-column table — and it moved with the table. Over it, `too many SQL variables`.
  
  Every fixture the kit ships is 2–6 rows, which is why this survived. It appears the first time a fixture is big enough to do the job fixtures exist for: `DEFAULT_PAGE_SIZE` is 25, so anything proving a paged list crosses the limit by construction. `pithy-sh/dashboard` hit it on its first realistic seed and split fourteen tables into twenty-nine groups by hand to get around it.
  
  The group is now written in chunks through `chunkRowsByBoundParameters`, sized from the row's own column count — the union of every row's keys, since that is what Kysely builds the column list from. Nothing about a fixture has to know the limit exists, and no adopter has to re-derive it after a confusing failure.
  
  Chunks are written in sequence and a group is not atomic across them. `INSERT OR IGNORE` is what makes that safe, and it is the same property that makes seeding re-runnable at all.
  
  The test asserts the invariant rather than a size: no statement the writer executes binds more than D1 accepts, at any width, at any length — measured at the D1 binding, so it holds whatever the writer does internally.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - No statement binds more than D1 accepts.
  
  D1 takes 100 bound parameters. Five capabilities bound a variable number into one statement without asking, while the arithmetic to avoid it sat in `core`'s `boundParameters.ts`, unimported. The primitive was never missing. It was never called.
  
  - **email** — the scheduler's claim bound two fixed parameters plus a batch sized by `SCHEDULER_BATCH_SIZE`. The default of 50 was safe; 100 bound 102 and every cron tick failed. A typo in that variable was worse: `NaN` produced one empty batch, so nothing was claimed, nothing was sent, and nothing said so.
  - **secrets** — `getValues` read every D1-backed secret the registry declares in one statement. An app declaring 101 of them could read none, and since every capability's secrets resolve through that one call, that is a Worker that does not start.
  - **rating** — `getMany` bound one parameter per player. `players` has a minimum of two and no maximum, and the docs promise any count, so a 120-player game failed every `recordResult`.
  - **leaderboard** — the rank refresh declared its own copy of D1's cap and a chunk size hand-derived from it. `RefreshOptions.chunkSize` was unvalidated: `40` bound 120, and `0` reported a board complete having ranked nobody.
  - **leaderboard, again** — a segment is a caller-supplied list. The HTTP route refused an oversized one; `topEntries` and `rankOf` are exported, and a direct caller's 120-friend segment reached D1 with 124 parameters.
  
  All five now go through `boundParameters.ts`. The private chunker is gone, and so is the duplicated constant.
  
  Two operator-supplied numbers had no ceiling, and neither has one now — the statements size themselves, so `SCHEDULER_BATCH_SIZE` is purely a fan-out knob and `chunkSize` purely a pacing one. What each refuses is a value that is not a count at all, named at the boundary, because there is no safe number to clamp a typo to.
  
  **The rule moved to the thing being called.** `createDatabase` — the one seam every Kysely instance in the kit comes from — now refuses a statement over the cap at `D1PreparedStatement.bind`, where the count is what the driver hands the platform rather than what a caller intended. A query site cannot opt out, and one that has never heard of the limit is covered anyway. The failure names the rule instead of leaving `too many SQL variables` for somebody to trace back to a list.
  
  The gate states the invariant rather than a file list: no statement this repository executes binds more parameters than D1 accepts, at any width. A gate naming the four known producers would have gone green the moment a fifth appeared — and a fifth appeared within a week of the fourth being fixed.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - The asset allowlist is derived from every environment's route table, not one
  
  `pithy dev` printed a sign-in URL that landed on the front end's 404. `/__pithy/dev-login` was not in
  `assets.run_worker_first`, so Cloudflare's asset router answered it with the SPA shell and the Worker never
  ran. `pithy ui sync --check` reported `every route reaches the worker` the whole time.
  
  Both halves were doing their job. `@pithy-sh/auth` mounts that route only in a `dev` composition with `CI`
  unset, because it mints an authenticated session with no credential presented — its absence from a shipped
  route table is the security property. And `pithy ui sync` derived the allowlist by composing the Worker once,
  under whatever environment the command happened to run in. That is not a `dev` composition, so the route did
  not exist to be found.
  
  **A Worker has one route table per environment.** The derivation now assembles it once per environment the
  project declares plus `dev`, and takes the union. Any conditionally-mounted route is covered without being
  named — gated on the environment, on a flag, on a capability being composed — so this closes the class rather
  than the one path. Reserving the `/__pithy` prefix wholesale would have fixed the symptom and left
  `--check`'s claim just as false for the next one.
  
  `CI` is deliberately ignored while deriving. `--check` runs in CI and `sync` runs on a laptop; a list that
  differed between them could never be checked. The asymmetry makes it free — an allowlist entry nothing serves
  costs a 404 from the Worker, a missing one costs a 200 with the wrong body.
  
  Production is unchanged: the route is still mounted only in `dev`, and still 404s everywhere else.
  
  Run `pithy ui sync` once. It adds `/__pithy` and `/__pithy/*`, and `--check` fails until you do. A project
  that added those entries by hand can drop the hand edit — the derivation writes them now.

- [#263](https://github.com/pithy-sh/pithy/pull/263) [`84beb3b`](https://github.com/pithy-sh/pithy/commit/84beb3b050b9f3643cfee9a11578a780cabd08df) Thanks [@kingmesal](https://github.com/kingmesal)! - A control-plane response says which build answered **and when that build was uploaded**.
  
  `workerVersion` read the `id` off `CF_VERSION_METADATA` and dropped the rest, and the module docstring described a binding with two fields. Measured against a real `wrangler dev`, it has three: `{ id, tag, timestamp }`, every value a string, `timestamp` an ISO-8601 instant. `workerVersionMetadata` now reads all of it; `workerVersion` is its `id` and keeps its shape, because four callers hold that shape and every one of them wants a single opaque string.
  
  The seam stamps a second header, `pithy-worker-version-created`, beside the existing one. Two headers rather than a richer value in the first: a client already deployed compares that whole string, so folding a field into it would make a kit upgrade read as a version change that never happened.
  
  **`workerBuildChanged` is the rule for reading the pair, and it ships beside the header names.** Compare field by field, only where both sides carried a value; anything that differs is a change. The rule lives in `controlPlane/wire.ts` because the dashboard did not only copy the header name, it wrote its own rule for the value — "invalidate when the id differs" — and a copied constant could never have caught that.
  
  **Absence stays silence**, in every direction — never seen, no longer sent, only just started, or blanked by something in between. A field the binding did not carry stamps no header, and a `timestamp` that is not a parseable instant is reported as absent rather than relayed. One gate states it: everything the seam says about the running build is a value the platform handed this Worker, byte for byte.
  
  **Versions and deployments are two objects, and this binding describes one of them.** A version is an immutable upload — id, created timestamp, tag, fixed at upload. A deployment points at one or more versions with traffic percentages, and is its own object with its own id and time. `CF_VERSION_METADATA` reports the version, and the runtime hands a Worker no binding for the deployment. So a rollback, which creates a new deployment aimed at an existing version, moves neither header — as does a traffic split or a gradual rollout. **Nothing inside a Worker can observe a deployment**; a client that needs one reads Cloudflare's deployments API. Measured on a real account on 2026-08-10 rather than inferred: two deploys, a real `wrangler rollback`, and the rolled-back-to version still reporting its original timestamp two minutes later.
  
  The comparison stays total anyway. The same-id-moved-timestamp branch is unreachable on today's platform and costs one line, and a rule that enumerates which fields are allowed to move is wrong the day the platform moves a different one — wrong silently, as "nothing changed".

- [#274](https://github.com/pithy-sh/pithy/pull/274) [`35aabdd`](https://github.com/pithy-sh/pithy/commit/35aabdd1f1153ac0ccedff35f224cf9ac596daa2) Thanks [@kingmesal](https://github.com/kingmesal)! - An audit event records which tenant it was for, not only which Worker wrote it.
  
  `pithy_audit_events` stamped `project`, `environment`, and `worker` from the recording Worker's own vars. Those say which deployment of ours wrote a row, and in a multi-tenant application all three are identical on every row — so nothing on the event distinguished one customer's administrative history from another's, and an app composing audit could not read its own trail without leaking across tenants.
  
  `actorId` was not that column. It answers *who*, not *for whom*, and the two part company the moment one person administers two accounts. Deriving the tenant afterwards from a membership table is wrong in both directions: joining tenant A today would hand you a year of tenant B's history, and leaving would take yours with you. The tenant of an action is a fact at the time of the action; membership is a fact now. So it is stamped on write.
  
  `AuditEvent` gains `tenant`, and it is the one dimension the **emitter** supplies — the recorder can neither forge it nor default it, because no Worker var knows which customer an action was for. The field's own description says so, in contrast to the three the recorder stamps: it is exactly as trustworthy as the emit site. Optional and nullable, permanently: a single-tenant app must not be made to invent one, and `null` means *not tenant-scoped* rather than unknown.
  
  `AuditQuery` gains the filter, including for null — `{ tenant: "org_7" }` is one customer's trail, `{ tenant: null }` is what was done outside any account, and omitting it filters nothing. Over HTTP the null filter is `?tenant=`, an empty value that no tenant id can collide with. The column is in the listing view as well as the detail one; a client that can filter by tenant but cannot see it has to take the filter on trust.
  
  `0001_init` carries the column and a `(tenant, occurred_at)` index for the read this exists to serve, with a tested `down`. An event nobody states a tenant for reads as null, exactly as `project`/`environment`/`worker` already document, and nothing back-fills them.
  
  Found building `pithy-sh/dashboard` on the kit: its "Our audit" pane could not be built without it, and every event recorded before it landed is permanently unattributable.

- [#299](https://github.com/pithy-sh/pithy/pull/299) [`a75a932`](https://github.com/pithy-sh/pithy/commit/a75a932b642026ed146f24bf63914ce6f0d8943f) Thanks [@kingmesal](https://github.com/kingmesal)! - A connection's lifecycle is recorded in the adopter's own trail.
  
  `ControlPlaneAuditActions` declared `connectionRegistered`, `connectionUpdated` and `connectionRemoved` from the day the seam shipped, and nothing emitted any of them. Not an oversight in a handler: those are the writes `pithy dashboard` performs by opening the adopter's D1 directly, so no request reaches their Worker and no route is in a position to record one. An adopter could read a *key* rotation in their trail but not the connection being created or destroyed — the larger event was the invisible one.
  
  The write records itself instead, in `connectionRegistry` rather than at its call sites. That module is already the CLI's only door onto the connections table, so "every CLI write to an adopter's connection row is recorded" now holds by construction. `connect` registers, `connect --update`, `connect --public-key` recovery and `revoke-key` update, `disconnect` removes.
  
  Three things this settles. **Where**: the event goes to a recorder built over the same `DB` handle the row was written through, never a database id resolved a second time — on `dev` those are not the same store. **When**: the row lands first and the event follows; a refused write records nothing, and a failed record cannot unwind a write and does not try. **Who**: not `control-plane`, which means a management client called in and proved it, but the adopter's own operator — named from their Cloudflare token where the command has one, `system` with a note where it does not, `worker` and `version` null because no Worker recorded it.
  
  `createCliAudit` gains an injected-database form for this. With a handle passed in, the Cloudflare pair becomes optional and names the actor rather than finding the database; a union type keeps that from loosening the ordinary case. A project not composing `audit` connects exactly as before.
  
  **A declared action code that nothing emits now fails the build.** `packages/cli/src/ci/auditActions.test.ts` compares every declared audit-action map against its use sites across the tree. It found one more on its first run — `PaymentsAuditActions.webhookUnverified`, so a notification failing its authenticity check throws 401 and records nothing — which is filed as [#296](https://github.com/pithy-sh/pithy/issues/296) and written down as the single exception there.

- [`3a75222`](https://github.com/pithy-sh/pithy/commit/3a752227e5030eb8f01668e1540a057b26cad163) Thanks [@kingmesal](https://github.com/kingmesal)! - Let a browser name a scope without acquiring `ExecutionContext`.
  
  A scope name is a string an admin client is supposed to know. The whole control-plane design has a client discovering a Worker's admin routes from the manifest and naming the scope each needs — `pithy-sh/dashboard` renders what a connection may do from these constants, and writes its `pithy dashboard connect --scope …` command from them, in a Vite client with the DOM lib and no Workers types.
  
  It could not. Four capabilities declared their scopes in the same module as their Hono middleware, so importing `PAYMENTS_ENTITLEMENT_GRANT_SCOPE` compiled `PithyHonoEnv`, which reached core's `capability.ts`, which named `ForwardableEmailMessage` and `ExecutionContext` off the global scope. Four errors, none of them in the adopter's own code, and no way to silence them short of excluding the kit from typechecking.
  
  **`@pithy-sh/ledger`, `@pithy-sh/payments`, `@pithy-sh/support` and `@pithy-sh/testers` now declare their scopes in `src/http/scopes.ts`** — the constants, the `*_CONTROL_PLANE_SCOPES` list, and the `*AdminRoutes()` builder, which belong beside them so the scope a route demands and the scope a manifest advertises stay one constant. No name changes and no value changes; the import path does. `guards.ts` keeps the middleware and imports the names like anything else. `@pithy-sh/audit`, `@pithy-sh/auth`, `@pithy-sh/email` and `@pithy-sh/secrets` already imported nothing but types and are untouched.
  
  **`capability.ts` imports `ForwardableEmailMessage` and `ExecutionContext` by name**, and `@pithy-sh/core` declares `@cloudflare/workers-types` as a dependency rather than a devDependency. A type this file names is a type its consumers must be able to get.
  
  **`sha256Base64Url` and `verifyEd25519` copy before they hash and verify.** `crypto.subtle` takes a `BufferSource`, which excludes a view onto a `SharedArrayBuffer`; a bare `Uint8Array` does not. Workers types spell `BufferSource` loosely enough that the mismatch never surfaced in a Worker, so this read as a DOM-lib nuisance — it is not. A digest of memory another thread can write is a check that does not bind what it checked, and body binding is the whole reason `bodySha256` exists. The copies are a request body and sixty-four bytes.
  
  `tooling/browser-scopes` is the gate, and it is three programs. One compiles every control-plane scope the kit declares under the DOM lib with `types: []`. One compiles the token primitives and the capability contract the same way, because the first program stopped reaching them the moment the scopes moved — a gate that passes whether or not the thing it proves is true is worth less than no gate. A test holds the fixture to every declared scope and holds each scope's home module to type-only imports, so the declaration cannot drift back in beside the middleware that reads it.

- [`0f912a2`](https://github.com/pithy-sh/pithy/commit/0f912a2677ea731d16659cf6d3f5e98b11d3c53f) Thanks [@kingmesal](https://github.com/kingmesal)! - A malformed secret was reported as absent, and the suggested remedy did nothing.
  
  `No SECRETS_ENCRYPTION_KEYS recorded. Run pithy add secrets.` said "absent" about a key that was there and failed its schema — and the command it named then returned without doing anything, because a key was already present. Three states collapsed into that one sentence: no project name, an unreadable file, and a stated value that will not read. Two investigations died in the third one, and one of them produced a work plan built on a refuted premise.
  
  **The reader no longer swallows what it read.** `statedMasterKey` answers with the value, with nothing, or with the sentence saying why — a type with a slot for each, instead of `string | undefined` and a bare `catch {}`. Nothing new is written: `requireProjectName`, `readDevSecretsSource`, `loadDevSecrets` and `storedSecretValue` each already named the secret, the file and the fix, and the defect was a `catch` throwing four good messages away. "Not recorded" is a claim about the file, and it is now made only when the file makes no claim.
  
  **`pithy doctor` judges what a stated value is, not that it is there.** `Object.hasOwn` was the entire check, so a value violating its own registry schema passed doctor and failed the next seed — the one command whose job that is. It is checked through the seeder's own `storedSecretValue`, so the two cannot come to two answers, reported apart from `missing`, and counted a fault. A file that will not parse now carries the loader's sentence rather than "run pithy seed to see which secret and why", which spent a round trip re-deriving what the run already knew.
  
  **The envelope parser rejects a non-envelope instead of stripping it into one.** `DevSecretEnvelope` accepted any object carrying `currentVersion` and `versions` and dropped the rest — so an `EncryptionConfig`, a structural superset of an envelope, parsed as one, lost `lastRotatedAt`, and left a base64 string where a nested object belongs. The failure then surfaced three frames later talking about version `"1"`. It is strict now, and the error says what was found: which keys, or which type. Keys and types only — the file holds OAuth client secrets.
  
  `sentenceOf` in `@pithy-sh/core` is where the two reporters get their one sentence from — a caught error's message and its `action`, never its `detail`. Both of them had grown a copy of it, and a three-line helper in two files is a helper that drifts.
  
  The format's guarantee is unchanged and is the reason for all three: the outer object is always the envelope. `SECRETS_ENCRYPTION_KEYS` carries a full envelope in the file like every other secret, and its binding carries the bare `EncryptionConfig`. That is `bootstrap`, it is correct, and nothing here alters it.

- [`16115c4`](https://github.com/pithy-sh/pithy/commit/16115c463287cd9222aaa05f9658020e43ec41b7) Thanks [@kingmesal](https://github.com/kingmesal)! - One unknown issuer failed a whole manifest, and the gate that should have caught it could not.
  
  **A key is an issuer.** `SecretIssuer` degrades an unrecognised name to `other` rather than throwing, because a manifest is read from `node_modules` and can be newer than the client reading it. The rule was written once, as a helper, and its own docstring says it lives in one place "because a rule stated at four field sites is a rule three of them will eventually miss." `needs` was the fifth site. It is *keyed* by issuer, and it restated the enum bare — so a capability shipping `issuer: "vercel"` did not degrade, it failed to parse, and one name a reader did not need took the whole manifest with it: every secret of every capability in the file. The degradation is now a const both shapes read, and the key degrades exactly as the field does.
  
  **A gate built from the fields it is checking cannot fail for the case it exists to catch.** The manifest↔registry test in auth, email and the secrets capability filtered the registry to the entries declaring both axes, then compared that to the manifest. An entry declaring *neither* axis is dropped from the expected list and is absent from the manifest, so it vanished from both sides and the comparison passed. Declaring neither is legal — `defineSecretRegistry` asks only for both or neither — and it is precisely the silent drift these declarations exist to end. The three now state the invariant instead: every registry entry appears in the manifest, and says where it comes from and how it is replaced. A fifth entry declaring nothing was planted in each; each went red naming it.
  
  The same reading found five capabilities whose secrets say neither — payments, storage, media, turnstile and support hold Stripe, R2 and Turnstile credentials that declare no origin and no rotation, appear in no manifest, and have no gate at all. Nothing here changes that. It is now visible.

- [`2d014a2`](https://github.com/pithy-sh/pithy/commit/2d014a29940281261a79deaba2d24a61339e3d80) Thanks [@kingmesal](https://github.com/kingmesal)! - Nine gates were green and could not fail. Each is now planted against and watched failing.
  
  They are one class, not nine bugs. A census of every test claiming a repo-wide or capability-wide invariant found eight shapes, and the two most common are the same mistake at different altitudes: a check derived from its own subject, and a set under test computed by calling the function under test. The taxonomy is written down in `packages/cli/src/ci/sweepPopulation.test.ts`, where the next gate author will meet it.
  
  **auth and support declare admin routes and asserted only one direction.** Five capabilities assert both. A route mounted with `requireControlPlane` and never declared was invisible to `missingAdminRoutes`, so a management surface could grow without ever reaching the manifest a client dispatches from. Both now probe the router with a credential-free request and hold the set that answers `controlplane/not_connected` against what the manifest declares — method and path, read from behavior rather than from the declaration under test.
  
  **payments pinned its route table by path.** `POST /payments/admin/purchases` beside the read was a write nobody declared and this file could not see: the path was already in the set, and a set does not count. Pinned by method and path now, as email's has been.
  
  **The store-backed-secret scan could not see a hyphenated, quoted or standalone declaration.** It found one of the two the kit ships and its anti-vacuity guard was `> 0`. It is driven off a text count now, every declaration must be named, and a shape the extractor cannot read raises instead of vanishing.
  
  **The mint-coverage gate named four registries and said it read them all.** Eight ship. The list is held against a scan of the packages, so a ninth `defineSecretRegistry` fails until somebody says what creates its arbitrary secrets.
  
  **The schema-description sweep walked object fields and stopped.** An object inside an array, an optional, a record or a union member was never reached. It follows every container Zod has, a kind it does not know throws rather than passing as a leaf, and it counts what it swept.
  
  **`requiredBindings` quantified fifteen manifests it never asserted it had.** With an empty walk the file collapses from 36 tests to 6 and stays green.
  
  **The core Worker-safety scan saw only `node:` specifiers**, with a floor of 20 against 104 modules. `import { createHash } from "crypto"` is a Node builtin and was invisible. Stated positively now: every specifier is relative or a declared dependency.
  
  **The one-printer JSONC gate matched two spellings of a write verb.** `writeFileSync` was not one of them. The write half is gone; what is checked is who can reach `comment-json`'s `stringify` at all.
  
  **The contract module's "no timer, no fetch, nothing from node" was four literals.** `setInterval` was not among them. The imports are an allowlist and the forbidden ambient names are the runtime's own globals, so the list cannot come out shorter than the rule.
  
  And a gate over the gates: every package-wide `import.meta.glob` sweep is partitioned into the ones that assert their population and the seventeen that do not. A new sweep is in neither list and fails there.

- [`1cf67d1`](https://github.com/pithy-sh/pithy/commit/1cf67d1a8f6e94be70643d6e3c4779eb0913612c) Thanks [@kingmesal](https://github.com/kingmesal)! - A key is not a field, and four capabilities could not go red.
  
  **Degrading a record key merges it.** `needs` is keyed by issuer, and [#324](https://github.com/pithy-sh/pithy/issues/324) gave the key the field's rule — `SecretIssuer.catch("other")`. On a field that rewrite is a rename and costs nothing; on a key it is a silent merge. Keyed that way, `{ vercel: ["deployments:write"], netlify: ["sites:write"] }` parsed to `{ other: ["sites:write"] }`: vercel's requirement gone, the parse successful, nothing anywhere reporting it. Requirements lost without a word are worse than a manifest that refuses to parse, because a refusal is visible. The key now keeps the name it was written with, held to the shape of a name, and a client that only knows the closed set narrows it with `SecretIssuer.safeParse` where it renders — the same answer it used to be handed, with the scopes still beside it and a second unknown issuer still a second entry.
  
  **The gate that filtered itself green was replaced in three capabilities by no gate in four.** Payments, storage, media and turnstile had no manifest↔registry test at all, and `@pithy-sh/secrets` had one over the capability's registry and none over the manager Worker's — so its Cloudflare account token declared both axes correctly and reached no client. Five of thirteen kit secrets declared neither origin nor rotation. All thirteen declare both now: the payment rails' bundle is obtained from four consoles and replaced by a human, R2 access-key pairs are made at Cloudflare and remade there because no API mints one, media's Images and Stream token and turnstile's widget secret are obtained from Cloudflare and rolled by Cloudflare's own API. Each capability states the invariant — every registry entry appears in the manifest, and says where it comes from and how it is replaced — and each was watched failing: an entry declaring neither axis was planted in all five, and all five went red naming it.

- [`3ad79d5`](https://github.com/pithy-sh/pithy/commit/3ad79d588d0dbac87003bdbf452443775529d7a3) Thanks [@kingmesal](https://github.com/kingmesal)! - Close the exemption the projection walk still granted, and enforce a support invariant that was only written down.
  
  `unpublishedIn` was extracted to end a fallthrough that returned `[]` for any type the walk could not name. One survived the extraction, wearing the branch that looked safe: `typeof` answers `"object"` for a `Date`, a `Map`, a `Set` and every class instance, and each of those descends to no keys and no leaves — a `Map`'s entries are not own properties, a getter lives on the prototype — so the descent handed out the same exemption the module exists to refuse. A row carrying a `Map` of ciphertext passed clean. So did a class instance whose only field was a getter returning a secret.
  
  The rule is now what the walk can see rather than a list of types it distrusts: a container is one whose whole contents `Object.entries` returns — prototype `Object.prototype`, `Array.prototype`, or `null` — and anything else is refused where `undefined` and `bigint` already were, naming the class in the message. `leavesIn` and `keysIn` descend on the same terms, because a caller builds its declaration from those and a value walked to nothing becomes a permitted set with a field missing from it. Round-trip through JSON first; that is what crosses. This primitive guards four disclosure surfaces, and the hole was in all four.
  
  `pithy_support_messages.fromAddress` was loosened to nullable for the one row that has no envelope — an answer delivered in the app — and the rule bounding that was prose on the field, in the same commit that put its sibling `emailJobId` behind a check on the object. It is a check now too, both ways: null exactly on an answer delivered in the app. A null on anything that traveled by mail is a thread nobody can answer, since the reply path addresses to it; an address on anything that did not claims a send that never happened.

- [`df8362f`](https://github.com/pithy-sh/pithy/commit/df8362f77007dbd9b3248785eaab0231967426ea) Thanks [@kingmesal](https://github.com/kingmesal)! - A `__proto__` key in a manifest is refused, where it used to disappear.
  
  `needs` on a `helped` secret is keyed by issuer, and a key is preserved verbatim rather than degraded — rewriting two unknown issuers onto `other` loses one of them's requirements in silence. That rule was written and, for one key name, never ran. `JSON.parse` gives `__proto__` an own property; Zod skips it while projecting a record, because assigning it would replace the prototype of the object being built. Both decisions are right on their own. Together they meant a key entered the parse, matched no rule, raised no issue, and was not in the result. `{ __proto__: ["deployments:write"] }` parsed successfully to `{}`.
  
  `manifestRecord` refuses it instead. Refuse rather than degrade: an unrecognised *issuer* degrades to `other` so a client built today can read a manifest written tomorrow, but `__proto__` is not a name a future issuer will carry, and degrading a key is the merge the key rule exists to prevent. A manifest that will not parse is reported by every client that reads it; a key that vanishes is reported by none.
  
  Both records a manifest may state are behind the guard — `needs`, and the object form of a config option's `default`. `manifestRecord.test.ts` walks `CapabilityManifest` and attacks every record it finds with a key that would vanish, so a record added later without the guard fails on the commit that adds it rather than on the manifest that exploits it.

- [`fa29441`](https://github.com/pithy-sh/pithy/commit/fa294411c8169e47f639c92e915fb248110bac08) Thanks [@kingmesal](https://github.com/kingmesal)! - Derive the entitlement census's own claim, and walk an array by everything it holds.
  
  Three gates that could not fail for the reason they exist.
  
  The entitlements census checked itself against the code in one direction. A writer's account was re-derived from the declaration's text on every run, so removing a guard failed — but `writes: false` was a bare claim nothing ever looked at, and an `insertInto(PAYMENTS_ENTITLEMENTS_TABLE)` added inside `keysToDerive` left the suite at eleven passed. Every mention is now classified from its own text and the census is compared against that, in both directions. The form list is positive: a mention matching none of them is not read as harmless, it is a failure quoting the line, so raw SQL and a Kysely verb nobody listed both land there rather than being absolved by omission.
  
  `unpublishedIn` stated that a container is one whose whole contents `Object.entries` returns, and then ran a different rule on arrays. `value.map` walks positions, and a position is not everything a plain array holds: `rows.cursor = "…"` sits on a prototype the walk accepts and was never visited — so a projection gate saw nothing, and `leavesIn`/`keysIn` built a permitted set with the field missing. `Object.entries` descends both branches now. An index key is still a position, reported as `[0]` and never a key a caller must permit.
  
  And the reconciliation read's anti-vacuity guard asserted its permitted facts with `toContain` over the serialized row, which a substring satisfies. It checks each one is present as a leaf. The catalog read beside it had the same slack — `"coins"` sits inside `"coins_100"` — and is fixed with it.

- [`ffb4dfe`](https://github.com/pithy-sh/pithy/commit/ffb4dfe135a3b3bb306d9ba7a14aaa7103db14e2) Thanks [@kingmesal](https://github.com/kingmesal)! - Refuse a key that vanishes wherever a payload states one, not only in a manifest.
  
  [#331](https://github.com/pithy-sh/pithy/issues/331) closed `__proto__` on two manifest fields. The exposure was never the field: `JSON.parse` gives the key an own property and Zod skips it while projecting, so it enters a parse, matches no rule, raises no issue, and is not in the result. Any record read from outside this process has that shape. `ClientProjection` did — a capability could write the key into its client projection at any depth, and the bundle came out without it with nothing said.
  
  `refusesVanishingKey` is the guard, `manifestRecord` is now its manifest wording, and both live in `capability/vanishingKey.ts`. The projection is guarded in two places and no more: on `JsonValue`'s record branch, which every object at every depth passes through, and on the projection's own top level, which is an object with a catchall and so is parsed by the object branch instead. The walk in `vanishingKey.test.ts` covers both roots and is what says two is all of them.
  
  `Object.create(null)` does not close this, which [#331](https://github.com/pithy-sh/pithy/issues/331) left open. Zod compares the key by name and skips it before assigning anything, so no prototype on either side of the parse is consulted — measured, and kept as a test. A guard in front of the schema is the only altitude that works.

- [`3bca514`](https://github.com/pithy-sh/pithy/commit/3bca514e9bfbe1bab8ddc62a8da622af252780ea) Thanks [@kingmesal](https://github.com/kingmesal)! - A manifest from a Worker deployed before the health fields parses again.
  
  `healthKeys` and `health` arrived required, so every Worker deployed before them failed validation — at
  the object level, which cost a client the whole manifest rather than the part it did not know about. The
  control-plane manifest carries no schema version on purpose, so tolerating absence is the only way a new
  field ships without breaking what is already running. Both default now, and an absent declaration means
  nothing declared, which is what it always meant.

- [`5f1dd10`](https://github.com/pithy-sh/pithy/commit/5f1dd10965494118a94ef5f0f11c1fd8726b9674) Thanks [@kingmesal](https://github.com/kingmesal)! - Carry a terminal Workflow step's `action` to the operator, so the remedy survives the boundary.
  
  [#349](https://github.com/pithy-sh/pithy/issues/349) got the step's sentence to the CLI. The line under it still died at the step: the engine records a throw's message and nothing else, and `classifiedSteps` wrote `${code}: ${message}`, so `SecretAlreadyExistsError`'s ``Use `update` to change an existing secret.`` had no field to ride in. A duplicate `pithy secrets create` said what was wrong and not what to do, where every other `PithyError` reaching the CLI says both.
  
  The encoding is a stated separator — one newline — and it lives in `@pithy-sh/core`'s `workflow/stepMessage.ts`, written by `classifiedSteps` and read by `@pithy-sh/cloudflare`'s `kitSentence`. One statement, two callers, no restatement. JSON was the other candidate and lost on the surface nobody controls: a step's raw text is read by a human in the Cloudflare dashboard, and a JSON blob there is worse than the two lines it would replace. A newline rather than a printable delimiter because a promoted message may not contain one — the rule [#349](https://github.com/pithy-sh/pithy/issues/349) already enforced — which is what makes the split total instead of best-effort. With no action the wire is byte-identical to what [#349](https://github.com/pithy-sh/pithy/issues/349) captured.
  
  Driven through the real CLI against a real local Workflows engine, `pithy secrets create` on a name that already exists now prints
  
  ```
  Secret 'api-token' already exists.
  Use `update` to change an existing secret.
  ```
  
  A step that states no remedy still prints one line and nothing after it — no empty line, no trailing separator, no `undefined`. `detail` does not cross, is not read into the encoding, and has no field to cross in.
  
  The gate is in `stepFailure.test.ts`, where both ends meet: the real `classifiedSteps` must produce a hand-written wire, and that same wire must read back as the stated sentence and action. Neither end can move without moving the literal. It was planted against — changing core's separator turns eight tests red across both packages.

- [`6e3c977`](https://github.com/pithy-sh/pithy/commit/6e3c977fe0aa7d0644aeac8a07c4032b5432d764) Thanks [@kingmesal](https://github.com/kingmesal)! - Make every codec report instead of throw, so `safeParse` keeps its promise.
  
  `safeParse` cannot throw. Only `parse` throws. Every boundary reader in this kit and in the dashboard is written on that — `const parsed = X.safeParse(body); return parsed.success ? parsed.data : null;` — and several say *never throws* in their own doc comment. Zod's `safeParse` catches a `ZodError` and nothing else, so an exception raised inside a codec transform walks straight past it and out of the reader.
  
  `JsonDate` and `SQLiteDate` threw an `InternalError` from inside `decode` when `Date` could not read the value. So `z.object({ at: JsonDate }).safeParse({ at: "not a date" })` did not return `{ success: false }`; it threw. Any reader over a shape containing a date was a 500 waiting for the first malformed timestamp a caller sent, and the caller picks the timestamp. The dashboard reads dates from customers' Workers on nearly every pane.
  
  Both now push a Zod issue and return `z.NEVER`: `Not a date.`, client-safe, with the offending value on the issue's `input` where `fromZodError` drops it. The check moved onto the decoded result rather than the string branch, so `8.64e15 + 1` is refused too — it was silently falling through to `z.date()`.
  
  The sweep found two more. `sqliteJson`'s `JSON.parse` throws a `SyntaxError` on a column holding text that is not a document, and its `JSON.stringify` throws a `TypeError` on a `BigInt` or a cycle the inner schema admits; both are issues now. `HttpError`'s encode ends in a `parse` inside `clientError`, which is defense in depth rather than a live bug, and is reported rather than raised for the same reason.
  
  `parse` still throws, as `parse` should — a `ZodError`, which `fromZodError` maps to `validation/invalid_input` like every other failed parse. A malformed timestamp from a customer is now a rejected field rather than an outage.
  
  The gate is `packages/cli/src/ci/codecSafety.test.ts`. It discovers every `z.codec(` under `packages/*/src` from the tree, holds the count to a frozen literal, and drives each one in both directions with inputs it must refuse. A codec added without a driver fails the build; so does a driver with no rejecting input. Fixing two functions would have left the fifth codec somebody writes next month exactly as exposed.

- [`bc3c8ec`](https://github.com/pithy-sh/pithy/commit/bc3c8ec8efb26028878aaf5bac1d276ff159149e) Thanks [@kingmesal](https://github.com/kingmesal)! - Report a terminal Workflow failure under the raising error's own code and status, not the transport's.
  
  [#349](https://github.com/pithy-sh/pithy/issues/349) got the step's sentence to the CLI and [#353](https://github.com/pithy-sh/pithy/issues/353) got its remedy. The `code` and the `status` were still `dispatchAndPoll`'s: it threw `CloudflareRequestError`, which fixes `cloudflare/request_failed` and 502 by construction, so `pithy secrets create` on a name that already exists answered with a 502 for a fault the step raised as `secrets/already_exists` with 409. **502 says the far side is broken and to try later; 409 says the thing exists and to do something else.** Anything branching on the pair — a retry loop, a CI step, an operator deciding whether to page — was told the opposite of what happened, and `cloudflare/request_failed` sent the reader at Cloudflare for a fault Cloudflare had nothing to do with.
  
  Four outcomes now, and a caller tells them apart on `code` alone:
  
  | What happened | Code | Status |
  |---|---|---|
  | A step raised, and the kit pins a status for its code | that code | that status |
  | The run ended terminally, nothing attributable | `core/workflow_failed` | 500 |
  | The dispatch or a poll could not be delivered | `cloudflare/request_failed` | 502 |
  | This client stopped waiting; the instance may still finish | `core/upstream_timeout` | 504 |
  
  The first two are terminal. The last two are not, and only they may be retried.
  
  **No fourth field crosses the durable boundary.** Nothing but `code`, `message` and `action` survives a step — the engine records the throw's text and discards the throw — and reopening the format [#353](https://github.com/pithy-sh/pithy/issues/353) froze against a measurement buys nothing here: every kit member pins `status` to one literal, so the code *is* the status. `kitErrorStatus` reads it off the union. A code the kit does not define has no pinned status, and rather than invent one the boundary says so with `core/workflow_failed` and keeps the step's own sentence.
  
  `core/workflow_failed` is a 500, deliberately not a 502: the durable job is the kit's own code in the operator's Worker, and its step journal — which `detail` names — is where the answer is.
  
  `detail` still does not cross. The only fields promoted from the far side are `message` and `action`, both already public and both already proved kit-authored.
  
  The gate is in `stepFailure.test.ts`: every captured instance states its expected code and status as hand-written literals, and the set of codes a terminal fault can arrive under is asserted disjoint from the transport's. Planted against five ways — restoring the old boundary turns 18 tests red across both packages.

- [`5ff5dd1`](https://github.com/pithy-sh/pithy/commit/5ff5dd1ad98c9ab469436c7fa2425e38c0662a18) Thanks [@kingmesal](https://github.com/kingmesal)! - A migration applies in one round trip, not one per statement.
  
  `kysely-d1` executes every compiled query as its own `prepare().bind().all()`, so a migration paid a hop to D1 for each `create table` and each `create index`. Composed, `replay/board` — audit, auth, secrets, email, payments — cost **104 round trips and 1,983ms per drop-and-rebuild** in the Workers runtime. It is now **24 and 355ms**: 5.6x, measured against that application and a real D1, not a synthetic one.
  
  That cost lands hardest where the kit's own advice sends people. `CLAUDE.md` tells adopters to test against real D1 and KV rather than mocks, and an adopter following it pays this once per test that needs a clean database — in `pithy-sh/dashboard`, 78% of total wall time, and a 700–1,900ms setup floor that put ordinary test bodies within reach of the 5,000ms timeout. Two load-bearing gates there went intermittent on it before anybody measured the setup. The kit tells people to test this way; the cost of testing this way is the kit's to keep reasonable.
  
  Each migration body now runs against a Kysely whose driver queues its statements and sends them as one `d1.batch()` when the body returns. `up` and `down` both, so `pithy migrate`, `--rollback`, `pithy seed --redo`'s reset and `pithy remove --drop` all benefit.
  
  **Only DDL is queued, and that is the whole safety argument.** A queued statement's result is handed back before the statement has run, so it cannot carry rows, a row count or an insert id. The queue therefore takes only statements that have no such result to carry — `create`/`drop`/`alter` on a table, index, view, schema or type. Every select, insert, update, delete and raw `sql` template flushes the queue and then executes on its own, exactly as before, so a read always sees everything written before it. A migration mixing data with DDL is split into several batches; it is correct and faster, just not one transaction.
  
  **Failure semantics changed, and for the better.** A migration that failed at its k-th statement used to leave statements 1..k-1 applied with no ledger row — a half-applied migration, the thing a chain exists to prevent. The batch is now the unit: a failure rolls all of it back and the ledger still records nothing.
  
  **Nothing changed across a migration boundary, and nothing may.** Each `up`/`down` builds its own queue and flushes before returning; the ledger row is written afterwards on the ordinary path. A chain that fails at its third migration still has its first two applied, recorded, and named in the error. Batching across migrations would make a partial chain unrepresentable in the ledger, which is worse than slow.

- [`bc1ddf1`](https://github.com/pithy-sh/pithy/commit/bc1ddf137d253790dc74633b09cb505fb1865bd6) Thanks [@kingmesal](https://github.com/kingmesal)! - Set the dependency floors the first release ships.
  
  `bun audit` went from 24 advisories to 5. The `hono` floor moves to `^4.13.2`, clearing seven —
  none reachable from the kit's own code, all reachable by an adopter composing `hono/cors` or
  `hono/jsx` through our range. `nanoid`, `postcss`, `fast-uri` and `js-yaml` cleared with a
  lockfile refresh.
  
  `postal-mime` moves to `^3.0.0`, and it is a security bump rather than a version bump. 2.7.x
  resolved a duplicated single-value header last-wins, so a sender could append a second `From:`
  below their own headers and choose the address `@pithy-sh/support` recorded as the sender, while
  every verdict above it was stamped against the topmost one. 3.0.0 resolves first-wins, which is the
  rule the header map already applied.
  
  Five undici advisories remain. Every `miniflare` 4.x pins `undici` at exactly `7.28.0`, so no
  floor of ours can move them, and miniflare 5 is alpha-only. miniflare is the local simulator; it is
  in no deployed Worker. `docs/STACK.md` §17 records that, and every other floor, with its reason.

- [#418](https://github.com/pithy-sh/pithy/pull/418) [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc) Thanks [@kingmesal](https://github.com/kingmesal)! - BRAND.md no longer rules on interface geometry. The mark is still a square.
  
  §10 said squared corners were product-wide — a ban on three CSS values, on any element, in any interface built on Pithy. It came from one sentence on `pithy-sh/dashboard#72`: *"let's try the sharp edge corners on the toggles for now and if I don't like them, we can change them later."* A preference to try something became a law binding every adopter's toggles, chips, avatars and status dots, and then a test in another repository enforcing it.
  
  Nothing in `packages/` ever cited it. Its only readers were one consuming application's stylesheet and that application's own gate. A brand document does not get to specify a consuming app's control geometry — composing `@pithy-sh/auth` gives this project no say in somebody's border radius — and a document that claims one is a document adopters are right to ignore, which devalues the sections that are real.
  
  So the section is deleted rather than narrowed: an amended §10 would still be doing the thing that was wrong with it. The retraction is recorded at §2.2 with its date, so the next person to notice that Pithy's own surfaces lean square does not write it down again. §2.2 itself is unchanged where it matters — the mark is a saffron square, and that was always the rule §10 was mistaken for.

- [`8c90e2c`](https://github.com/pithy-sh/pithy/commit/8c90e2c5b22b5a16e8372450af0d8068cfdacd29) Thanks [@kingmesal](https://github.com/kingmesal)! - Three Workflow hosts did not build, because a worker's module format is inferred from its default export.
  
  `@pithy-sh/support`, `@pithy-sh/media` and `@pithy-sh/vector` each ship a prebuilt Workflow host, and each exported only classes. wrangler decides a worker's **format** from one thing — whether the entry has a default export — so all three were read as service workers, and a service worker may not import `cloudflare:workers`:
  
  ```
  ▲ [WARNING] The entrypoint packages/support/src/workflows/worker.ts has exports like an ES Module,
            but hasn't defined a default export like a module worker normally would. Building the
            worker using "service-worker" format...
  ✘ [ERROR] Unexpected external import of "cloudflare:workers" and "cloudflare:workflows".
  ```
  
  `pithy dev` builds each worker separately and the other workers come up, so it scrolls past. The classification Workflow, the four enrichment Workflows and the reprocess Workflow simply were not running.
  
  **The four hosts that worked all have a cron.** Somebody wrote `export default { async scheduled(…) }` for the cron, and the module became an ES module as a side effect nobody named. The three with no cron had no reason to write one. A rule satisfied at the call site by whoever happened to need something else.
  
  So the rule is now stated where it belongs, and the population is derived rather than listed:
  
  > Every module in this kit that extends `WorkflowEntrypoint` has a default export.
  
  `cli/src/ci/workflowModuleFormat.test.ts` re-reads the tree on every run through the same walk the determinism gate uses, so a host added tomorrow is judged tomorrow with nothing to remember — and the walk finds hosts wherever they live, not under a `src/workflows/` glob. It is proved against fixtures in both directions before it is trusted against the tree.
  
  `workflowHostEntry(capability)` in `@pithy-sh/core/src/workflow/hostEntry` is what the three export. It refuses rather than being empty: `export default {}` would build and say nothing, while a Workflow host genuinely has no request surface — an app Worker starts its jobs through a Workflow binding — so an HTTP request arriving at one is a misconfiguration, and `core/not_found` naming the capability is the sentence that ends an operator's search. The `action` names the binding that does work and is stripped before the body goes out, like every other action.

- [`05fb8b4`](https://github.com/pithy-sh/pithy/commit/05fb8b4c83d0cd2aa923709cc0dac00010b1971d) Thanks [@kingmesal](https://github.com/kingmesal)! - Point the browser gate at every module a browser imports, and make all three families pass it.
  
  `[#419](https://github.com/pithy-sh/pithy/issues/419)` stated the rule and enforced it on one family: a module a browser may import reaches no module that needs the Workers runtime. It left the other two named rather than hidden. This is those two.
  
  **Ten modules were failing, not six, and thirty-nine faults cleared.** `[#430](https://github.com/pithy-sh/pithy/issues/430)` names four `src/http/scopes.ts` modules and two `src/http/schemas.ts` modules; `[#419](https://github.com/pithy-sh/pithy/issues/419)`'s changeset repeats the same count. Measured against the tree, eight scope modules were failing — because **`@pithy-sh/audit`, `@pithy-sh/auth`, `@pithy-sh/email` and `@pithy-sh/secrets` declare their control-plane scopes in a file called `guards.ts` that holds no guard**, byte-identical in its import list to a `scopes.ts` and identical in what it reached. So the gate derives the scope family **by declaration** — every module exporting a `ControlPlaneScope` constant, which is the walk `coverage.test.ts` already ran — and never by path. The obvious glob would have closed this issue half-way and said so nowhere.
  
  **`@pithy-sh/core`'s health seam is two modules now.** `controlPlane/discovery/adminRoute.ts` needs five things from `health.ts` to describe a manifest entry, and `health.ts` needs `Capability`, `PithyHonoEnv` and `Context` to define the seam a capability implements. Every capability's scope declaration imports `AdminRoute`, so all eight were compiling `@cloudflare/workers-types`, `hono`, `kysely` and `kysely-d1` — 46 kit files to declare five strings — while `coverage.test.ts`'s type-only rule was satisfied throughout. **The compiler follows a type-only edge exactly as it follows a value one**, and that rule was never the graph half of anything.
  
  The fourteen wire symbols — `HealthSummary`, `HealthSummaryKey`, `HealthSummaryValue`, `HealthValueKind`, `HealthValueCost`, `CapabilityHealthReport`, `CapabilityHealthWire`, `healthReport`, `healthWire`, `NamedHealthValue`, `namedHealthValues` and their supporting types — moved to `controlPlane/discovery/healthSummary.ts`, whose whole import list is `zod` and a scope. The seam stayed: `defineCapabilityHealth`, `capabilityHealthSources`, `readCapabilityHealth` and the branded types. **No symbol needed both sides.** `@pithy-sh/core`'s published surface is unchanged, name for name — the export block split in two and exports the same set.
  
  **Two constants moved out of Kysely readers, for the reason `[#419](https://github.com/pithy-sh/pithy/issues/419)` moved `SUPPORT_BILLING_SCOPE`.** A request schema is a client's business for the same reason a response schema is: §HTTP puts both halves of a route contract on the route line, and a management client composing a call needs the shape it may send. `@pithy-sh/leaderboard`'s `MAX_SEGMENT_SIZE` and `SEGMENT_FIXED_PARAMETERS` are now `rank/segment.ts`; `@pithy-sh/support`'s `DEFAULT_PAGE_SIZE` and `MAX_PAGE_SIZE` are now `store/paging.ts`. Both new modules import nothing.
  
  **`BOARD_KEY_PATTERN` moved too, and `croner` is why it is worth naming.** `leaderboard/src/http/schemas.ts` read the board-key regex out of `config/config.ts`, which validates a cron window through `window/schedule.ts`, which imports `croner` — a cron parser reached to spell `/^[a-z0-9][a-z0-9-]*$/`. `croner` runs in a browser perfectly well, so "add it to the allowlist" is the fix that will look like a one-liner to the next reader. It is the wrong one: **the allowlist is what a browser build may have, not what it can survive.** The regex is `config/boardKey.ts` now.
  
  **A fourth browser program, and a gate on the gates.** `tsconfig.schemas.json` compiles all fifteen request-schema modules under the DOM lib with `types: []` — the half `--listFilesOnly` deliberately skips, and the half `[#419](https://github.com/pithy-sh/pithy/issues/419)` needed both of. Because a program nobody runs is exactly the shape of a gate that cannot fail, `browserSurface.test.ts` (renamed from `responseCoverage.test.ts`; its subject is three families and one rule now) asserts that every `tsconfig.*.json` on disk is named by the `typecheck` script, reading both sides off disk. `turboInputs.test.ts` derives its file set from the same list rather than from one program, so a narrowed cache key over the other three can no longer replay green.
  
  The per-module vacuity floor is root membership rather than a file count: `core/src/controlPlane/scope/scope.ts` and three capabilities' request schemas legitimately compile to one kit file, and a program that does not contain its own root is the failure the count was aimed at.
  
  **Two holes under that gate, found in review and closed here.** The pattern matching a project file read `tsconfig(\.[a-z]+)?\.json`, so `tsconfig.extra2.json` and `tsconfig.dom-only.json` were each a browser program on disk the assertion reported as fine — planted, both were green until the pattern stopped constraining what TypeScript does not. And nothing bound a project's `include` to the source on disk, one level below the new gate: a `src/*.ts` no `include` reaches is compiled by no program at all, and vitest transpiles a test file without typechecking it. Every source file here is now asserted to be in some project's program, membership asked of `tsc --listFilesOnly` rather than of the lists themselves — a module reached by an import is typechecked whether or not a list names it.

- [`55af6d2`](https://github.com/pithy-sh/pithy/commit/55af6d2e421b8f476901e914124648e0c0ba0334) Thanks [@kingmesal](https://github.com/kingmesal)! - Seventeen packages import `@cloudflare/workers-types` and now declare it. It was a devDependency in every one of them.
  
  `@pithy-sh/core` got this right at [#315](https://github.com/pithy-sh/pithy/issues/315), and `tooling/browser-scopes/src/probe.ts` wrote down why in two halves: importing a package by name is what makes the dependency real, and declaring it as a dependency rather than a devDependency is what makes it satisfiable. Fourteen packages had the first half and not the second. Three more had neither. The entry moves section; the range stays `^5.20260729.1` verbatim, and the root `overrides` pin is untouched.
  
  **The reason it never bit here is not the reason the issue gave.** The issue said a published tarball ships bundled `.d.ts` from tsdown with the types inlined, so an adopter never asks. Nothing in this repository uses tsdown. No package publishes typings from `dist`; every one declares `"exports": { "./src/*": "./src/*.ts" }`, so **every** adopter compiles our raw TypeScript inside their own program — and a devDependency of ours is not installed for them. That makes the fault wider than the `pithy init` case the issue described, not narrower. What actually hid it is local: Bun hoists the workspace and the root pin gives every member one copy, so a sibling's devDependency resolves for everything in this tree. `docs/STACK.md` has prescribed `bun add zod @cloudflare/workers-types` — `bun add`, not `bun add -d` — the whole time. The manifests drifted from it one copied sibling at a time.
  
  Seventeen tarballs therefore gain a runtime dependency, `@pithy-sh/cli`'s among them, and the Workers types are several megabytes of `.d.ts`. That is the correct size for a package that publishes source importing them.
  
  **Two keep theirs as devDependencies**: `turnstile` and `tooling/vite-adopter`. Neither reaches a Workers type at all — turnstile's verifier is a `fetch` to Cloudflare's siteverify endpoint and the `Response` it reads is a global every Node program has, and vite-adopter is a compile fixture rather than a published capability. Promoting them would put that payload in two adopters' installs for nothing.
  
  **Nineteen files were not importing anything, and that is the half an import-by-name gate cannot see.** They put a Workers global in a signature — `D1Database`, `D1Meta`, `D1PreparedStatement`, `D1Result`, `KVNamespace`, `DurableObjectNamespace`, `ExecutionContext`, `ForwardableEmailMessage` — resolved through `types` in each package's own `tsconfig.json`. An adopter compiling that source gets `Cannot find name`, exactly as they would on a missing import, while every gate reads the package as clean. They import the names now: `audit`, `auth`, `cli`, `cloudflare`, `core`, `email`, `matchmaking` and `rating`.
  
  `packages/cli/src/ci/workersTypes.test.ts` is the gate, and it holds three directions: a package that imports the types declares them, a package that does not import them does not, and **no shipped source anywhere in the workspace names a Workers global it did not import**. That last record is empty, and empty is the assertion — a file that stops importing a name it still uses lands back in it and fails.
  
  The sweep only means that because it reads every workspace member. Its first draft read the two packages that declare the types without importing them, which is 2 of 25, and reported the tree clean while thirteen files were not; `packages/matchmaking/src/data/tables.ts` was byte-for-byte the shape `packages/rating` had just been fixed out of. It is also self-widening, which it demonstrated twice: `D1Result` was invisible because the only named import of it in the tree was in a `.test.ts`, and importing it in one file made the second file naming it ambiently fail immediately.
  
  A name the host platform declares is excluded, and the host is asked rather than listed — `ReadableStream` enters the vocabulary because `@pithy-sh/storage` imports it by name, and casting `Response.body` to it is not the ambient defect in any runtime. `name in globalThis`, measured against the Node 22 floor every package states.
  
  The gate is scoped to this one specifier. The general rule — every bare specifier a shipped source imports is a declared dependency — is the shape, and the docblock says why it is not asserted yet: the same sweep finds `vitest` and `miniflare` reached from `src/test-utils/*.ts` files that ship because nobody excluded them, and making a test framework a runtime dependency of the CLI would be the wrong answer to that.

- [`802513a`](https://github.com/pithy-sh/pithy/commit/802513a473828eee404b08d328a912b6b1faa8a4) Thanks [@kingmesal](https://github.com/kingmesal)! - The Workers Vitest integration is `@cloudflare/vitest-plugin`, and a scaffolded project says so.
  
  Cloudflare published version 1 of the Workers Vitest integration under a new name. `@cloudflare/vitest-pool-workers` is `@cloudflare/vitest-plugin`, and the configuration API is unchanged. The old name is not deprecated on npm — its `latest` is `0.22.0`, published two days before `@cloudflare/vitest-plugin@1.0.0` — but version 1 is where the integration continues, so that is what to follow. Every package here takes the new one at `^1.0.0`.
  
  **Your repository needs the same three edits**, and a `pithy init` scaffold has already had them. The dependency in `package.json`, the `cloudflareTest` import in `vitest.workers.config.ts`, and the `/// <reference types="@cloudflare/vitest-plugin/types" />` line in `cloudflare-test.d.ts`. Cloudflare ship a codemod that does all three — `bunx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`, with `--dry-run` to read it first. It rewrites prose as readily as code, so check what it touched.
  
  **Seventeen of these eighteen releases change nothing you can run, and that is the point.** Bytes do move in all eighteen tarballs — `bun pm pack --dry-run` shows every capability package shipping its `package.json`, its `src/cloudflare-test.d.ts`, and in sixteen cases its `vitest.workers.config.ts`, and this commit rewrites all three. None of them is runtime code: a devDependency name, a `/// <reference types>` line, and a test config. Nothing an import of `@pithy-sh/<capability>` reaches is touched. A patch version that says so is how the note above gets to the repositories that need it. `@pithy-sh/cli` is the one real change: it vendors `templates/starter`, so `pithy init` now scaffolds the new name.
  
  **The rename is not free, and the cost is one line of `docs/STACK.md`.** The old caret held the test harness on `miniflare` 4 for nothing — for a `0.x` package it resolved below the 0.20.0 that first pinned a `miniflare@5.x-alpha`. Version 1 is that same line renamed, so `*.workers.test.ts` now runs on `miniflare@5.20260820.0-alpha` and workerd `1.20260820.1`. That is dev-side only, and it is not the first alpha here: `wrangler` is a devDependency of eighteen packages under `packages/`, hoisting to one `wrangler@4.123.0` that has carried a nested 5.x-alpha for our own suites all along. The kit ships no wrangler — `pithy dev` execs the one in your repository. What the kit *does* ship is `miniflare` itself, a runtime dependency of `@pithy-sh/cli` that `pithy migrate` and `pithy seed` construct, and that stays declared at `^4.20260722.1`. So the harness and the migrator now run different workerd builds, and no common compatibility date holds them together — nothing the CLI constructs `Miniflare` with passes one. `docs/STACK.md` names that exposure rather than leaving it to be found.
  
  `packages/core/src/worker/envIsolation.workers.test.ts` is new, and pins the `process.env` a workers test sees. `@pithy-sh/core` declares no `files` and carries no `.npmignore`, so `src` packs whole and that file goes to the registry with it — the second tarball here to gain content rather than only rename it. That is core's packaging, unchanged by this commit and not a thing to fix inside it. The test-isolation gate exempts workers projects because workerd inherits nothing from the host, and that reason was a comment reporting a count from an older workerd. It is an assertion now — and the gate resolves the path it cites, so the evidence cannot be renamed away while the exemption stays green.
  
  Nothing in this repository reached for `fetchMock` from `cloudflare:test`. It went in 0.13.0 — the same single release that replaced `defineWorkersConfig`/`poolOptions.workers` with the `cloudflareTest` plugin, and the one `packages/core/vitest.workers.config.ts` names for that. 0.12.21 still exports `defineWorkersConfig` and still ships `fetchMock`; 0.13.0 exports neither. `cloudflare:test` is imported for `env`, `runInDurableObject` and `runDurableObjectAlarm`, and for nothing else.

- [`31a7620`](https://github.com/pithy-sh/pithy/commit/31a7620a6bc5a05d43a4ec00cb4395af28fff0a5) Thanks [@kingmesal](https://github.com/kingmesal)! - The kit writes American English, and an email job is `canceled`.
  
  **One line here is a break, and it is the `@pithy-sh/email` job status.** `EmailJobStatus` spelled its final state `cancelled`; it is `canceled` now. That string is not internal — it is a column value in `pithy_email_jobs`, the `status` field of every job the control-plane routes return, the `?status=` filter on `GET /email/jobs`, and the `status` of the `SendOutcome` a send resolves to. **If your code compares `status === "cancelled"`, or filters a job listing on it, that comparison is now always false and you must update it.** Nothing warns you: it is a string against a string, so it fails quietly by matching nothing rather than by throwing. Grep your repository for the seven-letter spelling before you take this minor.
  
  **There is no migration, and that is a fact about this moment rather than a shortcut.** `0001_init.ts` declares the column as `.addColumn("status", "text", (c) => c.notNull())` — bare text, no CHECK, no enum — so the value set lives only in Zod and the database has nothing to alter. And no database anywhere holds a row spelling it the old way: every package is `0.0.0`, `npm view @pithy-sh/email version` still 404s, and `0001_init` *is* the schema under CONTRIBUTING.md's pre-publish rule. Both halves were re-checked before the value moved. **Once a version is cut this inverts** — a status value that has been written somewhere real is history, and changing it then costs a migration plus a compatibility window for the rows already carrying it.
  
  **The two capabilities stopped spelling one concept two ways, and they got there from opposite directions.** `@pithy-sh/payments` already had `canceled` in `PurchaseStatus`, and it keeps it because it is *Paddle's* wire value — rewriting a vendor's own string would be inventing a translation layer over somebody else's API. `@pithy-sh/email`'s was the kit's own vocabulary: nobody else names those states, so the spelling was ours to pick and we picked the one the rest of the prose uses. Two arguments, one spelling. The reason is written above the enum in `email/src/data/enums.ts` so the next reader finds the decision instead of re-deriving it.
  
  **Every other package here changes prose only, and no runtime behavior moves in any of them.** Comments, doc comments, test names, Zod `.describe()` text, `docs/`, each package's own `README.md` and `docs/`, and the `templates/` starter that `pithy init` vendors — en-GB spellings became en-US throughout. The package READMEs matter more than their line count suggests: sixteen of the eighteen manifests declare no `files`, so a README ships in the tarball and is the most-read prose here. Bytes do move in these tarballs, because `src` packs whole and a `.describe()` string is runtime data an adopter can read; nothing an import reaches behaves differently. Twenty of the twenty-one packages carried at least one. `@pithy-sh/multiplayer` carried none and takes no bump.
  
  **A sweep like this is mostly a list of words it must not touch, and that list is the work.** Several near-neighbors are already correct American English and were left alone: `cancellation`, `fulfilled` / `fulfilling` / `fulfillment`, and `enrolled` / `enrolling` all keep their spelling, and only the exact words `fulfil` and `enrol` moved. `programme` was read one instance at a time rather than replaced, because it is right in both dialects when it means a broadcast and wrong when it means a scheme. Two third-party wire values that look exactly like the thing being fixed stay as they are: Lemon Squeezy sends `cancelled` and `payments/src/rails/lemonSqueezy/objects.ts` still maps `case "cancelled": return "canceled";`, which is the boundary doing its job, and Cloudflare's own build outcome in `@pithy-sh/cloudflare` is `cancelled` because that is what the API returns.
  
  **A census keeps it true.** The rule is *the words this project writes are American*, and it is now a test over committed source rather than a thing whoever greps next has to remember. It was watched failing on a planted spelling before it was trusted, and it is proven not to flag a wire value, a generated vendor notice, or a quoted third-party string — by planting one of each. The exceptions are named with their reasons beside them, which is the part a word list alone could never carry.

- [`2337456`](https://github.com/pithy-sh/pithy/commit/2337456baed2faba0372d19d88489eb4ad80254b) Thanks [@kingmesal](https://github.com/kingmesal)! - A workers suite cannot see a Cloudflare credential, and the guard that says so cannot be emptied.
  
  [#198](https://github.com/pithy-sh/pithy/issues/198) stopped unit suites authenticating against a live account, and the fix exempted every `*.workers.test.ts` project on a sound reason: workerd inherits nothing from the host, so there is no ambient token to blank. That answers **inheritance** and says nothing about **declaration**. A `cloudflareTest({ miniflare: { bindings } })` entry writes a host-computed value into workerd's `process.env` by design — five configs use it for `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()`, a key minted for the test and exactly what bindings are for — and the shape one line over is `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`. Nothing refused it. The exemption was a door.
  
  **Two gates close it, and they are halves rather than duplicates.** `vitest.workers.setup.ts` at the repository root runs inside workerd and throws on any Cloudflare credential visible there, whatever put it in — a binding, a future pool option, a harness change nobody read. All seventeen workers projects load it. And `packages/cli/src/ci/testIsolation.test.ts` refuses a workers config that reads `process.env` at all. Neither is redundant: a declaration reading the operator's shell carries nothing on a machine with no token exported, which is every CI runner, so the runtime guard passes a real leak on exactly the machine the gate has to be trusted on. Measured — a planted `process.env.CLOUDFLARE_API_TOKEN ?? ""` ran 166 tests green with no token exported. The scan owns the declaration; the guard owns the runtime.
  
  **The runtime guard reads the bindings, not only `process.env`, because a compatibility flag decided whether those are the same thing.** A declared binding lands in `process.env` only while the config states `compatibilityFlags: ["nodejs_compat"]`. Measured on `@pithy-sh/core`: delete that one line, declare `bindings: { CLOUDFLARE_API_TOKEN: "leaked-nocompat" }`, and the whole set goes green — the scan returns `[]`, the workerd assertions pass, and the credential is fully readable from any test through `env` from `cloudflare:test`. Blindness cannot be detected from inside either: with the flag and without it, `typeof process` is `"object"`, the key set is the same seven, and `process.version` is `"v22.19.0"`. So the guard reads the bindings themselves, where no flag can hide them, and `testIsolation.test.ts` holds every workers config to the flag — a suite exercising a workerd the deployed Worker is not is worth refusing on its own.
  
  **The source scan follows the imports rather than the file name.** Its own docblock rejected a narrower rule as "walked around by a helper that reads the environment one call away", and a rule scoped to `vitest.workers.config.ts` had that hole: all seventeen import `../../vitest.shared`, where an `export const HOST_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ""` would be invisible and would flow straight into a `bindings` entry. The population is now every repository module a config reaches, transitively — derived by walking relative imports, so the next one is covered by the commit that adds it — and a specifier the walk cannot resolve is reported rather than skipped. The stripper it reads through is string-aware for the same reason: a `//` inside a URL and a `/*` inside a `**/*` glob each forged a comment that blanked a real `process.env` read, and both were silent.
  
  **`visibleCredentialKeys` is the one new export**, on `@pithy-sh/cloudflare`'s `src/env/devVars`. It answers which of `CLOUDFLARE_ENV_KEYS` an environment carries a non-empty value for — non-empty, because `vitest.shared.ts` pins all four to `""` and the CLI's `process.env` overlay already reads a blank as unset. That module imports nothing at all, and now must keep importing nothing: it is bundled into workerd as well as run on the host, so a `node:` import in it breaks seventeen suites at collection.
  
  **The guard is gated on doing something, which for one review it was not.** Every check around it proved seventeen configs cite the file and that the file exists. Replace its body with `export {};` and all of them stay green — 18 passed in the CLI gate, 169 in `@pithy-sh/core`'s workers project — with the whole mechanism retired in silence. That is this repository's named recurring defect one level up from where the change looked for it. So the guard records its scan on `globalThis` and `packages/core/src/worker/envIsolation.workers.test.ts` reads the record back from inside workerd, where the guard runs. The throw is the one clause still held by text, and deliberately: proving it at runtime means putting a live credential into a real workers pool.
  
  **The scaffolded config is scanned too.** `templates/starter/vitest.workers.config.ts` can state neither setup file — both are absolute paths only this checkout has — so it stays out of the walk that loads configs. It does not stay out of the source scan, which names no path and forbids a text. It is the one workers config in this tree that becomes somebody else's code, so a scaffolded `bindings: { CLOUDFLARE_API_TOKEN: … }` would ship from here and reach *their* account.
  
  **Nothing changes for an adopter's own repository.** The scaffold is unchanged, and the guard is a repository-root file that `pithy init` does not copy. What moves in these tarballs is a `setupFiles` line in seventeen `vitest.workers.config.ts` files that pack with their `src`, plus the new function — no runtime code, and nothing an import of `@pithy-sh/<capability>` reaches.

- [`31dd6e9`](https://github.com/pithy-sh/pithy/commit/31dd6e935b157a5dac4d23eec9ca2f5b60b4f3b3) Thanks [@kingmesal](https://github.com/kingmesal)! - `blankComments` strips comments from TypeScript source without mistaking a string for one.
  
  A pattern over comments has no notion of a string, so a string is where a comment is forged. A `//` inside a URL opens a line comment and blanks the rest of the line. An unbalanced `/*` inside a `**/*` glob opens a block comment that runs to the next `*/` anywhere later in the file. Both were measured: planted into this package's own shipped source, the URL shape hid a bare `D1Database` from the gate that exists to find it, and the gate passed.
  
  It is a character walk instead. Comments are blanked rather than deleted, so every line number and every offset survives and a caller may split, index or slice against the original. Strings are stepped over rather than blanked, which keeps a real read inside a template literal visible. A regex literal is stepped over too, told from division by the last significant character, and an unterminated string or regex stops at the newline so a wrong guess costs one line rather than the rest of the file.
  
  It lives here because this is the package every caller may import. `@pithy-sh/core` must not depend on `@pithy-sh/cli`, and `worker-safety.test.ts` needs the walk — so the CLI could not hold it. The module imports nothing and touches no Node builtin, which is the property that same gate enforces.

- [`818a596`](https://github.com/pithy-sh/pithy/commit/818a59624d1b2fa4370cd713abb66f3bdbbc746f) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker launched by a custom `dev.command` is told its own origin too.
  
  The first half of [#462](https://github.com/pithy-sh/pithy/issues/462) handed a Worker its allocated origin as `--var BASE_URL` on the `wrangler dev` argv. That misses every UI-bearing Pithy app, which is most of them: they run through a custom `dev.command` — a Vite dev server, not wrangler — where there is no argv to append to. The Worker that motivated the issue was one of them, so the first half fixed the four workers that were already fine and not the one that was broken.
  
  `@cloudflare/vite-plugin` takes a Worker's `vars` from `wrangler.jsonc` and offers exactly one way in: the `config` customizer. So the value travels in that child's **environment** — `PITHY_WORKER_ORIGIN`, declared in `@pithy-sh/core`'s `worker/identity.ts` beside `ENVIRONMENT_VAR`, because `pithy dev` writes it and `@pithy-sh/vite` reads it and those two packages cannot import each other — and `devWorkerConfig()` turns it into the binding:
  
  ```ts
  cloudflare({ config: devWorkerConfig() })
  ```
  
  `pithy init` scaffolds that line. An existing project adds it once; there is no way around that, because the customizer lives in the adopter's `vite.config.ts` and nothing else can reach the Worker's vars.
  
  **Two carriers, one value.** `ownOriginFor` is what both the argv path and the environment path read, so they cannot drift — and a capability host is exempt from both by one function rather than by a condition repeated at each. Its `BASE_URL` stays the *app's* origin, because a host holds no public route and a verification link it mails has to arrive back at the app.
  
  **Per child, which is why it could not go in the shared table.** `buildWorkerEnv` is built once for every child: `<STEM>_ORIGIN` is the same table of *other people's* addresses for everybody. "Where do I answer" is the one fact that differs per child, so `childEnvFor` adds it to that child's environment and to no one else's.
  
  Outside `pithy dev` the helper contributes nothing and the declared value stands — which is what a deployed environment wants, since `applyDomains` generated it from `domains`. It never invents an origin; it only passes on one that was allocated.
  
  Verified end to end against `pithy-sh/dashboard` in a checkout allocated block index 2: the seed registered the self-connection at `http://localhost:8827`, the Worker minted `iss: http://localhost:8827`, and `GET /control-plane/manifest` answered **200** with the composed capability list. Before this it answered 401.

- [`829ead9`](https://github.com/pithy-sh/pithy/commit/829ead903f8b41574f3581d659761e88a2d56d9a) Thanks [@kingmesal](https://github.com/kingmesal)! - A subscriber can change, end, or be refunded their plan.
  
  `payments` could take a first payment and nothing after it. A subscription could be started and then
  only watched: no upgrade, no downgrade, no cancellation, no refund, and no way to ask what any of
  those would cost before committing to one. Every adopter who needed them wrote the rail calls
  themselves, against the one API the capability exists to keep them away from.
  
  `SubscriptionRail` is that seam, with `RefundRail` beside it as a separate contract — a store that
  settles refunds is not necessarily one that manages subscriptions, and folding them into one
  interface would make every implementer claim both. Paddle implements both. Six routes are mounted
  under the capability's own base path: read the standing, preview a change, commit one, cancel, keep
  a canceled plan, and refund.
  
  **A quote is three parts, because a deferred downgrade has three**: what settles today, what lands
  on the next invoice and when, and what the subscription pays after that. `SubscriptionSettlement` is
  a discriminated union of `charge`, `credit` and `nothing`, because a credit and a charge are the
  same digits and the opposite meaning, and a screen that renders a bare number gets to be wrong in
  one direction without knowing it.
  
  **Every quoted figure carries the string to print it with.** `QuotedMoney.rendered` is required, not
  optional, so a caller cannot reach for the integer and format it themselves. `renderMoney` places
  the decimal lexically rather than by division, and takes the exponent from ISO 4217's
  `minorUnitDigits` rather than from `Intl` — those disagree. `Intl` carries CLDR *display* digits,
  which round HUF and COP to whole units, and Paddle sells in both: `6582` HUF renders as `HUF 66`
  through `Intl` and `HUF 65.82` through the denomination. A store's own formatted total is used where
  the store provides one; `pricingPreview.preview` is the only Paddle endpoint that returns
  `formatted_totals`, so the rest are rendered here.
  
  `PaymentsSubscriptionChangeRefusedError` (409) is the refusal a store gives when a change cannot be
  made — a plan already on that product, a subscription past its window. It is a stated outcome
  rather than a failed request, and it carries the Spanish string with it.

- [`2bfb410`](https://github.com/pithy-sh/pithy/commit/2bfb41068b43979e5ff127b20bb5193b7a724410) Thanks [@kingmesal](https://github.com/kingmesal)! - A reconciliation pass can be started through the control plane, instead of waiting for the cron.
  
  Reconciliation is the repair path for a dropped `subscription.updated` webhook: until a pass runs, a
  customer who paid holds no entitlement and a customer who canceled still does. There was a read of the
  run log and no way to start one, so the answer to *"my subscription isn't showing up"* was
  `pithy payments reconcile` — a laptop, a checkout and a Cloudflare API token — or nothing until 04:00.
  
  `POST {base}/admin/reconcile-runs` starts a pass and answers `{ started, runId }`.
  
  **`payments:reconcile:run` is its own scope, and that is the sharpest split in the list.** Reading the
  log says whether the nightly repair has been firing; starting a pass calls the store, walks the catalog
  and *writes entitlements* — granting what a webhook never granted, revoking what a missed cancellation
  left standing. A health monitor holding `:read` to alarm on a stopped cron must not be able to move
  somebody's access, and `scopeCovers` matches exactly, so it cannot.
  
  **A missing Workflow binding refuses rather than degrading.** `triggerWorkflow` skips an `optional` job
  with a warning, which is right for a background dispatch on a request that works without it. It is wrong
  here: somebody pressed a button to make a pass happen, and `202 started` over a pass that will never run
  is the one answer worse than a refusal. The binding is resolved directly, and its absence is a 501 —
  `payments/reconcile_not_provisioned` — naming the deploy that fixes it. Not a 404, which sends a reader
  looking for a typo, and not a 500, which sends them to logs for something that did not fail.
  
  Idempotent, like the pass itself: a second press while one is in flight starts nothing and says
  `started: false`, which is true rather than a 409 that reads as a fault.
  
  Fixes [#469](https://github.com/pithy-sh/pithy/issues/469)

- [#71](https://github.com/pithy-sh/pithy/pull/71) [`bb65b40`](https://github.com/pithy-sh/pithy/commit/bb65b409a2c1fcdf262de7d39c00314ff135979c) Thanks [@kingmesal](https://github.com/kingmesal)! - Add the `rating/*` and `matchmaking/*` error codes to the `ErrorPayload` union, so the two new capabilities throw namespaced, wire-safe errors like every other.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - The rest of the line a manifest writes into a generated config.
  
  [#171](https://github.com/pithy-sh/pithy/issues/171) narrowed what a manifest may state as an option's **value**, so the renderer could only be handed shapes it prints the way Biome would. It left the option's `key` and its `describe` as `z.string().min(1)`, and both are interpolated raw into the TypeScript `pithy add` and `pithy upgrade` write. `renderConfigValue` guarded the keys of a *nested* object and threw; the line's own key had no guard at all.
  
  The schema parsed every one of these and the renderer emitted every one of them: `content-type` became `content-type: "x",`, which is not TypeScript — Biome answers with three parse errors. So did `a"b`, `1`, `a b`, and `}) ; evil(`. A `describe` carrying a newline put its second line into `pithy.config.ts` as bare code; one with trailing whitespace failed `biome format`.
  
  This is not only a formatting bug. A manifest is read from `node_modules/@pithy-sh/<cap>/pithy.manifest.json` — third-party data — and an option key is that data interpolated unescaped into generated source. `}) ; evil(` is the shape that makes the point. Nothing shipped today carries such a key: all 15 manifests and their 40 options are bare, so this was latent, and it predates [#171](https://github.com/pithy-sh/pithy/issues/171).
  
  `ConfigOption.key` is now a bare identifier and `ConfigOption.describe` is one line with no trailing whitespace — [#171](https://github.com/pithy-sh/pithy/issues/171)'s own argument applied to the rest of the line. The refusal names the manifest and the option: `@pithy-sh/audit ships a malformed pithy.manifest.json: configOptions[1].key — A config option key must be a bare identifier, and "content-type" is not`. `renderConfigOptionLine` refuses the same keys, because `--set` reaches it without passing through a manifest.
  
  The comment above the line had two producers, which is how the line below it came to have two in the first place. `renderConfigOptionComment` is now that one function, and `pithy add` and `pithy upgrade` both call it. `MissingConfigKey` stops copying the manifest's contract for `key` and `describe` and refers to it, as its `default` already did.
  
  Every boundary here was measured by running Biome, not guessed. A line terminator ends a `//` comment and trailing whitespace fails the formatter; leading whitespace, an interior tab, non-ASCII, `${x}` and a comment of any length do not. A test renders both lines for every option in every manifest the repo ships into a real scaffold and runs that scaffold's own `biome check` over the result, with a control that proves the gate bites.

- [#191](https://github.com/pithy-sh/pithy/pull/191) [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503) Thanks [@kingmesal](https://github.com/kingmesal)! - A capability's own name and package, and the rule that stops the fourth one.
  
  [#171](https://github.com/pithy-sh/pithy/issues/171) narrowed a manifest option's **value**. [#174](https://github.com/pithy-sh/pithy/issues/174) narrowed its **key** and its **describe**. Neither touched the capability's own `name`, which reaches generated TypeScript twice — the import binding and the registration call — or its `package`, which reaches the import specifier. Both were still `z.string().min(1)`.
  
  Reproduced with the real CLI. A manifest declaring `"name": "audit }) ; evil("` was accepted, and `pithy add audit` wrote
  
  ```ts
  import { audit }) ; evil( } from "@pithy-sh/audit/src/index";
      audit }) ; evil((),
  ```
  
  then reported `Done.` A `"package": "@pithy-sh/audit/src/index\"; evil(); //"` closed the quoted specifier and appended a statement, and reported `Done.` too. A manifest is third-party data read from `node_modules`; this is that data interpolated unescaped into a file the adopter's own `bun run lint`, `tsc` and runtime all read.
  
  `CapabilityManifest.name` is now a bare identifier and `package` an npm package name. `peerCapabilities` and `optionalCapabilities` are held to the same rule as `name`, because that is what they are. The refusal names the manifest and the field, as [#174](https://github.com/pithy-sh/pithy/issues/174)'s does: `@pithy-sh/audit ships a malformed pithy.manifest.json: name — A capability name must be a bare identifier, and "audit }) ; evil(" is not`.
  
  The two lines have producers now, as the option's two lines got in [#174](https://github.com/pithy-sh/pithy/issues/174): `renderCapabilityImport` and `renderCapabilityRegistration` in `@pithy-sh/core`, total over what the schema parses. `pithy add` writes both through them; `pithy upgrade` writes the registration head through the second when it converts a one-liner into a block, which was the third place the name was interpolated by hand.
  
  **The part that matters is the gate.** Three rounds, three fields, one rule that kept living at the call site that had just been fixed — so the rule is stated at the schema and enforced by a test that walks it: every string a manifest may state carries a pattern or a refinement, or it is named in `NEVER_RENDERED` with the reason no generated file can carry it. A string field added to `CapabilityManifest` with neither fails the build on the commit that adds it, whatever it is called. Deny by default, because enumerating the fields known at the time is exactly what produced the first two misses. A second test renders the **whole** config `pithy add` would write for every capability the repo ships — imports, registrations, option lines — and puts it through a real scaffold's own `biome check`, with a control that proves the gate bites.
  
  Every consumer of `name` was checked under the narrowed type. The catalog now has a test that every built-in entry states a name and a package the manifest schema would accept, since a mismatch there would read as "not installed" forever. `pithy add --eject` builds its fork directory from the name, so the names that could escape `./capabilities/` are exactly the names the schema now refuses. `remove`'s test fixtures go through `parse` rather than a cast.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - One filter decides what a runtime's error may say to an adopter ([#228](https://github.com/pithy-sh/pithy/issues/228)).
  
  `safeReason` is the control that stops a parser diagnostic — a multi-line ANSI box quoting an absolute path and the adopter's own source line — from landing in a `PithyError`'s `action`, which the CLI renderer prints and the HTTP codec does not strip. It existed three times, near-verbatim: `project/config.ts`, `capabilities/loadFailure.ts`, and the vite plugin's `workerConfig.ts`, each with its own `ABSOLUTE_PATH`, its own ANSI regex, and its own copy of the tests around them.
  
  A security control in triplicate is one fix away from being a security control in duplicate, and that already happened once. [#223](https://github.com/pithy-sh/pithy/issues/223) found that testing *content* let Bun's build-failure wrapper through — `2 errors building "app/config:12:5.ts"` carries no leading slash, so it passed the absolute-path check and dragged a fabricated `Line 12, column 5` out of the file name with it — and closing it meant editing three files correctly, by someone who knew all three were there.
  
  [#223](https://github.com/pithy-sh/pithy/issues/223) moved `rootCause`, `prop` and `isBuildFailureWrapper` into core as recorded facts about a runtime and deliberately left the rest, on the reading that what a surface may say is that surface's business. That is true of the sentences and false of the filter. Whether a string carries a path, a stack frame or half an ANSI box is a property of the string, and three surfaces cannot hold three answers to it without two of them being wrong.
  
  So the filter moved and the policy did not. `safeReason`, `causeMessage`, `failurePosition` and `unresolvedSpecifier` are `@pithy-sh/core`'s, with the provenance suppression written **once** — a build-failure wrapper is refused before a single content test runs, and `failurePosition` refuses the same shape for the same reason, so no position is ever invented out of a file name again. What each classifier recognizes as unresolved or unparseable, and what it tells an adopter, stays where it was: the capability loader still holds a bad subpath out of its resolution branch, and the three refusals still say their own three sentences.
  
  `@pithy-sh/vite` still depends on `@pithy-sh/core` and on nothing else in the kit. That constraint is what made core the right home for `rootCause`, and it is what makes it the right home for this.
  
  The invariant is a gate rather than a claim: **no module outside core decides whether a cause's message is safe to show.** `project/config.test.ts` walks every shipped source file in the repository and fails on any module that declares a message-safety filter of its own — a function named for the safety of a reason, or its own absolute-path recognizer, the constant no copy of this managed to do without. Proven by planting a fourth copy in the vite plugin and watching it name the file. De-coloring is not flagged: `dev/logging.ts` strips ANSI to render a log line, and formatting is not a decision about what an adopter may be told.
