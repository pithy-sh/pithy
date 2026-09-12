# @pithy-sh/i18n

## 0.5.0

### Patch Changes

- [#565](https://github.com/pithy-sh/pithy/pull/565) [`0657549`](https://github.com/pithy-sh/pithy/commit/0657549d250a2f97c591d7ab1336f0e019d72831) Thanks [@kingmesal](https://github.com/kingmesal)! - Connect a provider whose email differs from your account's.
  
  A GitHub account whose primary address is not the one you signed up with could be signed in with but never attached. Signed in, you can now connect it: both sides are proven at that moment, and the address still has to be one the provider has verified.
  
  Connecting requires a recent sign-in rather than merely a valid session. Attaching a provider grants permanent access — afterwards sign-in resolves by account id and the email stops mattering — so it is gated the way disconnecting one already is, and the refusal is recorded.
  
  The window measures time since you authenticated, which is not the age of your session. Sessions carry a new `authenticated_at`, stamped at sign-in and carried forward verbatim by `/token/rotate`; a migration adds the column, and a session that predates it stays undated through every rotation, so it re-authenticates once and never fakes freshness. Gating on session age instead would have been reset by every ordinary refresh, and on demand by anyone holding a stolen refresh token.
  
  Security: attaching a social provider now requires an authentication from the last fifteen minutes, measured so that a token rotation cannot reset it.

- [#562](https://github.com/pithy-sh/pithy/pull/562) [`f254c69`](https://github.com/pithy-sh/pithy/commit/f254c6920976cd0b01a4d97e78291f6ee2344469) Thanks [@kingmesal](https://github.com/kingmesal)! - The sign-in screen stops promising an account a provider will refuse.
  
  With email sign-up on and `github: { allowSignUp: false }` — the configuration per-provider sign-up exists for — the screen said "Signing in creates one." directly beneath a GitHub button that would refuse. True of the link, false of the button, and the reader found out after a full round trip to GitHub.
  
  Each provider's sign-up policy now reaches the browser, so the sentence can say which half it means. Nothing changes for a project where everything may sign up.
  
  A copied screen predating the field reads it as absent, which means "no provider refuses" — what every project's behavior was until now.
- Updated dependencies [[`0657549`](https://github.com/pithy-sh/pithy/commit/0657549d250a2f97c591d7ab1336f0e019d72831)]:
  - @pithy-sh/core@0.5.0

## 0.4.1

### Patch Changes

- [#557](https://github.com/pithy-sh/pithy/pull/557) [`a65cc8f`](https://github.com/pithy-sh/pithy/commit/a65cc8f4b55d6ee584e87b2a743b34bc9d4e4465) Thanks [@kingmesal](https://github.com/kingmesal)! - GitHub sign-in no longer mints a second, empty account.
  
  A GitHub account whose primary address is not the one you signed up with matched nothing here, and signing in created a fresh user beside your real one. That is most people's GitHub — a personal primary with the work address secondary — and there was no way to say "GitHub may sign people in, but not create accounts."
  
  `allowSignUp` is now per provider, so a project can let email create accounts while GitHub only signs existing ones in. A GitHub sign-in matching no account refuses and mints nothing, and the sign-in screen explains why in three sentences: what GitHub told us, that a secondary address will not do it, and the remedy. A bare refusal would send somebody to verify an address that is already correct.
  
  The resolution rule is the kit's now, and yours to replace with `auth({ resolveGithubUserInfo })`. It reads the primary and only the primary, reports GitHub's own per-address verified flag rather than asserting one, and fails closed when GitHub does not answer — so an outage reads as an outage instead of "your account does not exist."
  
  A provider is also no longer the last way in. Magic link is unconditional here, so unlinking the only connected provider is allowed — which is what makes an account stranded by the old behavior recoverable without a merge rule: sign in to it by email, disconnect GitHub, then connect it where it belongs.
  
  Connecting a GitHub whose primary differs from your account's address is still refused, deliberately, and `docs/github-oauth.md` says what that is waiting on.
- Updated dependencies []:
  - @pithy-sh/core@0.4.1

## 0.4.0

### Minor Changes

- [#544](https://github.com/pithy-sh/pithy/pull/544) [`3e55d2f`](https://github.com/pithy-sh/pithy/commit/3e55d2f467527c5f329b47e81c3d150c701feef9) Thanks [@kingmesal](https://github.com/kingmesal)! - A shared `@pithy-sh/*` package is a `peerDependency`, so a project cannot end up holding two copies of one.
  
  `@pithy-sh/core` was a plain `dependency` of every capability. Its types cross every seam, so an adopter who ends up with two copies gets `Type 'X' is not assignable to type 'X'` across their whole Worker — from a dependency graph that is, by every declared range, entirely valid.
  
  The 2026-09-10 release bumped eight packages to `core ^0.3.1`. Seven others still declared `^0.3.0`, which **accepts** 0.3.1 — but a lockfile records resolutions, and bun does not move one it already holds. A plain `bun install` after bumping the ranges left `auth`, `payments`, `email`, `audit`, `support`, `testers` and `turnstile` on `core@0.3.0` while the app resolved `0.3.1`. An isolated linker gives each package its own `node_modules`, so those copies never appear at the path anyone would look at: `node_modules/@pithy-sh/core/package.json` reported `0.3.1` and the upgrade looked like it had landed. Then the build failed 404 times, naming APIs that exist — `Property 'enqueue' does not exist on type 'Capability<…>'` — because there were two `Capability` declarations, two Hono env types, and two of every schema type that crosses a seam.
  
  **`@pithy-sh/secrets` is worse, because its split is a runtime fault rather than a compile-time one.** `sharedSecretsStore` holds its configuration in a module-level `let`, and `configureSharedSecrets()` sets it on the instance the caller imported. With two copies the `secrets` capability configures one and every capability that reads a secret holds the other. Reproduced on a dev server with a present, well-formed Google credential: `POST /auth/sign-in/social` → 500, `{"code":"core/internal","message":"The shared secrets accessor is not configured."}`. The payload's `detail` says `configureSharedSecrets was never called` and `clientError` strips `detail` — correctly; that is the security boundary — so the operator reads *not configured* about a capability they had composed, and a UI rendered it as *"Google didn't answer"*, naming a service never contacted.
  
  **`@pithy-sh/core` carries the same hazard, and its symptom points somewhere else again.** `capability/composition.ts` holds `let composed` in a module-level binding: `createBackend` writes it through `recordComposition` after every `compose` hook, and `composedCapabilities()` reads it. Split `core` and the backend records into one instance while a Workflow reads the other, finds `null`, and refuses with `This job could not reach the application's capabilities.` — action: `Export the Workflow class from the same worker entrypoint that calls createBackend.` That is entrypoint wiring, and it is not the cause. The function's own comment already warns about the confusion a missing answer creates here: an empty one would be *"indistinguishable from 'no backend was assembled' — two very different things to tell somebody reading a log at 3am."* A duplicated module walks straight into the ambiguity the code anticipated.
  
  So two packages carry state a split turns into a runtime fault, and both are packages every adopter composes.
  
  Re-releasing the dependents fixes neither: `^0.3.0` already accepts 0.3.1, and an adopter's lockfile holding `auth@0.1.6` keeps its resolution whatever `auth@0.1.7` declares. Bun offers no dedupe — measured on 1.3.14, `bun pm dedupe` does not exist, and `bun update @pithy-sh/core` and `bun update --force` both leave the split — so every adopter's remaining options were a permanent `overrides` line or deleting the lockfile.
  
  **A `dependency` is the kit saying *I need some copy of this*. A `peerDependency` is the kit saying *you and I must share one*, which is the true statement and the one every package manager acts on.** `@pithy-sh/core` is now a peer of every package that imports it; `@pithy-sh/secrets`, `@pithy-sh/email`, `@pithy-sh/storage`, `@pithy-sh/turnstile` and `@pithy-sh/cloudflare` are peers of the packages that import them. npm, pnpm and bun install a peer once, at the top, where the adopter's own import finds it too, and the split stops being a resolution somebody has to notice.
  
  **`pithy add <capability>` declares the peers on the Worker that composes it.** It already did this for `zod`, `kysely` and `hono`; it skipped anything under `@pithy-sh/*` on the reasoning that a kit peer is a *prerequisite capability* the adopter composes on their own terms. That was true only while every kit peer happened to be optional. The skip is now `peerDependenciesMeta.optional` alone, which says both things at once: an optional peer — React, or a composed capability like `@pithy-sh/auth` under `@pithy-sh/support` — is still left to `pithy add`, and a required one arrives with the capability that needs it.
  
  Two packages turned out to declare a kit dependency they never import. `@pithy-sh/audit` declared `@pithy-sh/cloudflare` and reaches it from no source at all — four doc comments, and `resolveActor` deliberately declares the slices it needs *structurally* so it does not have to. `@pithy-sh/vector` declared `@pithy-sh/cloudflare` for one integration test, and `@pithy-sh/secrets` for nothing. Both are gone; the test-only one is a `devDependency`.
  
  **Two gates hold it.** `ci/kitPeerDeps.test.ts` derives the rule from the imports rather than from a list — a package that imports a kit package peers it, one that does not, does not, both directions — and pins the range shape (`^` the version that package is at, agreed by every declarer), the `workspace:*` devDependency each needs to build itself, and the exact set of peers that may be optional. It also holds `pithy init`'s starter Worker to declaring every required peer of every kit package it declares. Beside it, `ci/kitCopies.ts` walks the resolved tree and fails on any `@pithy-sh/*` that resolves to two directories — identity is `realpath`, so an isolated linker's forest of symlinks reads as the one module it is, and two copies at the same version still count as two, because module state is per instance.
  
  `@pithy-sh/cli` keeps plain `dependencies`, and that is a decision rather than an omission. Nothing composes it: no adopter imports it, no `Capability` of its making crosses into a Worker, and its types appear in nobody's build — a peer exists to force one shared copy between a library and the graph it is composed into, and a bin is not in one. `pithy init` also runs in a directory with no project, where a peer is unmet by construction, and a globally installed `pithy` has no adopter graph to be hoisted into; peering would make the CLI's behavior depend on how it was installed. The CLI reading its own copy of `@pithy-sh/secrets` and `@pithy-sh/email` while an adopter's Worker reads theirs is a separate, known defect with a separate fix — a project-based loader, not a peer range.
  
  Whether `sharedSecretsStore`'s configuration should be module state at all is left open. One copy makes this instance of it correct; state reachable only through one module instance is fragile in any bundler that decides to duplicate, and that is its own question.

### Patch Changes

- Updated dependencies [[`caab3fa`](https://github.com/pithy-sh/pithy/commit/caab3fab1c08b7f4b8f515c03d7d58e08e4f7bae), [`3e55d2f`](https://github.com/pithy-sh/pithy/commit/3e55d2f467527c5f329b47e81c3d150c701feef9)]:
  - @pithy-sh/core@0.4.0

## 0.3.1

### Patch Changes

- [#540](https://github.com/pithy-sh/pithy/pull/540) [`231b726`](https://github.com/pithy-sh/pithy/commit/231b72603b284c139e00eab92a52af34a7e86bd3) Thanks [@kingmesal](https://github.com/kingmesal)! - A Cloudflare refusal says what Cloudflare said, and what to do about it.
  
  Every v4 endpoint answers a failure with `{ success: false, errors: [{ code, message, documentation_url }] }`, and Pithy projected none of it. A token missing one product's grant, a revoked token, a token pointed at the wrong account and an outage all rendered as the same sentence: the operation, a period, nothing else. The refusal now carries Cloudflare's own code, sentence and docs link on the problem line, marked with `Cloudflare said:`, and — only where Cloudflare's own code says the credentials failed — one action line naming the three things that produce it.
  
  The code is the discriminator, not the status. Cloudflare answers `10000` under 400, 401 and 403 depending on the endpoint, so keying on 403 would have missed the refusal that raised this. The converse is just as wrong and shipped first: a 403 is also how Cloudflare answers `10021 Script startup exceeded CPU limit`, and "add Account → Workers Scripts to it" changes nothing about a CPU limit. Where Cloudflare named any code, the codes decide; only a body-less throw falls back to the status.
  
  The action names three remedies because the refusal separates none of them. It named two for one round — "reaches other Cloudflare products" → add the grant, "reaches none" → replace the token — which excluded the wrong account by construction: a token in the wrong account reaches plenty in *its* account, so the operator was told to add a grant they already held.
  
  One place words a refusal, and `client/refusalSites.test.ts` is what makes that a fact rather than a memory. Five paths were composing their own, not the one the first round named: `mintToken`, the Stream direct upload, `CloudflareBuildsManager`, and two live-integration helpers. `mintToken` was the costly one — `pithy token mint` is where an under-scoped bootstrap token is refused first, and on the identical 401 body it printed `Failed to mint account token 'pithy-prod-deploy'.` and stopped. A hand-built `PithyError` is also invisible to `cloudflareRequest`'s wrapper, which opens `if (error instanceof PithyError) throw error` — so it could not be repaired from one place afterwards.
  
  A call that ran out of time is `core/upstream_timeout` (504), the code CLAUDE.md §Errors asks for, and no longer a 502. The split is a fact a caller acts on: a 502 says Cloudflare answered and refused, so the same call refuses again; a 504 says nobody answered, so it may succeed — and may already have been applied. `@pithy-sh/media`'s enrichment policy retries the new code, so a Stream timeout does not become terminal on the day it acquires its own name.
  
  **A `message` is one line, and the answer is marked with a word rather than an indent.** The first cut of this made the refusal a small document — problem line, `errors[]` indented beneath, action last — which reads beautifully in a terminal and is unencodable everywhere else. The newline is a *field separator*: `renderTerminal` uses it for the action line, and a durable Workflow step uses it to carry a terminal throw's remedy across the boundary in the one string the engine records. So a Cloudflare refusal raised inside a `classifiedSteps` step — the secrets rotation write-back, media's Stream reads, payments' reconcile — was declined whole by the step reader, and the operator got `core/workflow_failed` 500, "The Workflow instance failed.", on exactly the failure this issue exists to explain. Upstream text is still flattened before it is measured, for the same reason it always was: an unindented line at the bottom of an error reads as the remedy, and upstream text does not get to write Pithy's remedy. The composed sentence is bounded by the step channel's own limit, so a refusal survives the boundary it has to cross. The encoder is total now too — it flattens and truncates rather than writing something its reader declines — so no future writer can lose the whole channel by handing it a shape.
  
  **A timed-out call is detected off what the producers actually throw.** The 504 branch shipped reading `error.name` and `error.code`, and neither producer sets either: the SDK's `APIConnectionTimeoutError` assigns no `name` at all (`name` is `"Error"`, `code` is `undefined`, and the class name is its only marker), and `fetch` rejects a connect timeout with `TypeError: fetch failed` and puts undici's `UND_ERR_CONNECT_TIMEOUT` one level down on `cause`. So the branch could not fire for either, every real timeout classified as `cloudflare/request_failed`, and `@pithy-sh/secrets`' rotation — which retries `core/upstream_timeout` and refuses that — called the most retryable failure it has permanent. The predicate now reads the class name as well as `name`, walks the `cause` chain, and treats a throw carrying a status as an answer whatever is underneath it. Its fixtures come off a real SDK client against a real dead socket rather than out of an `Object.assign`.
  
  **The permission hint is on the call that refuses first.** `pithy token mint` is `rollToken → findTokenByName → listTokens`, then `listPermissionGroups`, and only then the mint, all on the same credential — so a hint attached to the mint alone was one the operator never reached. Every account-token endpoint carries it now, and the 403 on `tokens.create` keeps its own diagnosis *and* Cloudflare's answer with it, instead of trading one for the other.
  
  A Spanish reader gets the answer too. `cloudflareRefusal` is the first throw site in the kit to pass `params`, which falsified a premise three files were written against — that none did, so no locale could name a placeholder. `core`'s `GUARANTEED_ERROR_PARAMS` is the declaration a call could not be: the names a code supplies on **every** path, degraded ones included. `apiAnswer` is the first, it carries its own separator so one sentence closes correctly with an answer and without, and `@pithy-sh/i18n`'s gate now holds a locale to the declaration in both directions instead of banning placeholders outright. The declaration is a promise about *throws*, so the throws are gated too: the refusal class supplies the guarantee structurally, and a code recovered off a step boundary — where `params` cannot travel — re-raises with the guaranteed names empty rather than leaving a Spanish reader the literal `{apiAnswer}`.
- Updated dependencies [[`231b726`](https://github.com/pithy-sh/pithy/commit/231b72603b284c139e00eab92a52af34a7e86bd3)]:
  - @pithy-sh/core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [[`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5), [`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5), [`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5), [`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5), [`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5), [`a24ebff`](https://github.com/pithy-sh/pithy/commit/a24ebff4bbe18f5571344dd3f79113a809494fc5)]:
  - @pithy-sh/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`ac4db92`](https://github.com/pithy-sh/pithy/commit/ac4db92f6549c57c88b68d68eccaa552480ec437)]:
  - @pithy-sh/core@0.2.0

## 0.1.5

### Patch Changes

- [`1b3a116`](https://github.com/pithy-sh/pithy/commit/1b3a116e2f21d9c80fa1e494270205f7f8224c2c) Thanks [@kingmesal](https://github.com/kingmesal)! - Every distributed file carries its SPDX notice.
  
  The source stamper has always run on `src`. Nothing stamped what is built from it — tsdown drops a file's leading comment on emit, and `tsc --emitDeclarationOnly` drops one that is not attached to a declaration — so the `.js` and `.d.ts` an adopter actually opens carried no notice while every source file did. The tarballs have always shipped `LICENSE` and declared a license, so nothing was ever unlicensed; what was missing is the notice on the artifact.
  
  Both halves are stamped now, from **the package's own declared license**, through the same `buildHeader` that writes source. `@pithy-sh/audit` is `FSL-1.1-MIT`, so this is not a formality: a notice fixed at MIT would have put the wrong terms on its compiled output while its source read correctly.
  
  `bun run verify-published` refuses a tarball shipping a `dist` file without one.
  
  No code changed in this release for most of these packages — the bytes differ only by the two comment lines at the top of each built file.
- Updated dependencies [[`82bb9a0`](https://github.com/pithy-sh/pithy/commit/82bb9a0ce3a70ac0f66cc86d8b7bae64f9a3109e), [`509d921`](https://github.com/pithy-sh/pithy/commit/509d921580b6630d27a7534f29206e8e8a4d3678), [`1b3a116`](https://github.com/pithy-sh/pithy/commit/1b3a116e2f21d9c80fa1e494270205f7f8224c2c)]:
  - @pithy-sh/core@0.1.5

## 0.1.4

### Patch Changes

- [#492](https://github.com/pithy-sh/pithy/pull/492) [`8941abb`](https://github.com/pithy-sh/pithy/commit/8941abbb8a0e1cfe4827a4cf2a820f34e88b306b) Thanks [@kingmesal](https://github.com/kingmesal)! - A scaffolded Worker declares the runtimes its capabilities require, so the project can load them.
  
  0.1.3 made `zod`, `kysely` and `hono` peer dependencies of every capability — one copy is one type — and shipped without the other half. A peer is a requirement the *consumer* satisfies: npm installs one at the top, and **bun, for a workspace member, does not**. So a project scaffolded by `pithy init` declared its capabilities, nothing declared their peers, and `@pithy-sh/core` could not load inside it at all:
  
  ```
  $ node -e 'import("@pithy-sh/core/src/error/pithyError")'   # from apps/board
  ERR_MODULE_NOT_FOUND: Cannot find package '@pithy-sh/core'
  ```
  
  `hono` was the one of the three that never broke, because the Worker template had always declared it. `zod` and `kysely` are declared beside it now, by both producers of a Worker manifest.
  
  **`pithy add` carries a capability's required peers with it**, read from the installed package rather than from a list, so a capability that needs something new is handled without a release. Two kinds are skipped: an optional peer — `payments` and `i18n` declare `react`, used only by their `client/` and `react/` modules, and a server composition never loads one — and a kit sibling, which is a prerequisite the CLI already refuses on and names.
  
  `react` is marked `optional` on those two, which is what it always was.
  
  If you are on 0.1.3 and your Worker builds, you already declare these and nothing changes. If it does not, upgrading fixes it — or add `zod` and `kysely` to `apps/<worker>/package.json` by hand.
- Updated dependencies []:
  - @pithy-sh/core@0.1.4

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
- Updated dependencies [[`9579441`](https://github.com/pithy-sh/pithy/commit/9579441c0cd49bb690f21451a8ec07460e1220d9), [`24d3245`](https://github.com/pithy-sh/pithy/commit/24d32459145ccedd8b2c3b6cf715646acdfdabaa), [`800abda`](https://github.com/pithy-sh/pithy/commit/800abdaae3ef4b584c3b0060642d49ebd098fa67), [`c8e45ba`](https://github.com/pithy-sh/pithy/commit/c8e45baeac30231559ba53dba4b7b9a4a10cd46a), [`8ed1f95`](https://github.com/pithy-sh/pithy/commit/8ed1f958925f6987a1cc357225631b56221d5621)]:
  - @pithy-sh/core@0.1.3

## 0.1.2

### Patch Changes

- [`b8673f3`](https://github.com/pithy-sh/pithy/commit/b8673f3a08377ecaff9f43aad600d6aae0660ef4) Thanks [@kingmesal](https://github.com/kingmesal)! - Every package installs from npm. Twenty of them did not.
  
  `0.1.0` and `0.1.1` published their dependencies on sibling packages as `workspace:*`. That is a Bun, pnpm and yarn convention, and **npm does not implement it** — measured both ways, `npm pack` leaves it verbatim from the package directory and from the repository root with `-w`. Changesets publishes through `npm publish`, so the range reached the registry unrewritten and no resolver could do anything with it. `bun add @pithy-sh/cli` failed before installing anything. Only `core` and `ui-react` worked, because they depend on no sibling.
  
  Internal dependencies now carry a concrete range, which Changesets already maintains across releases, and which still resolves to the workspace locally — a package's siblings link exactly as before.
  
  **Nothing in this repository could have caught it.** Every test here runs inside the workspace, where `workspace:*` resolves perfectly; the range is only wrong once it leaves. So the check moved to where the evidence is: `verify-published` now extracts the manifest from a real tarball rather than reading the one on disk, and fails on a workspace range in anything a consumer installs. A devDependency keeps it, because a consumer never installs one.
- Updated dependencies [[`b8673f3`](https://github.com/pithy-sh/pithy/commit/b8673f3a08377ecaff9f43aad600d6aae0660ef4)]:
  - @pithy-sh/core@0.1.2

## 0.1.1

### Patch Changes

- [`dfda7b2`](https://github.com/pithy-sh/pithy/commit/dfda7b25c897f3fe30ad7d498dde1216a25edc09) Thanks [@kingmesal](https://github.com/kingmesal)! - Released from CI, with provenance.
  
  Every package's first release was cut from a laptop, and a laptop has no OIDC identity to attest with — so `0.1.0` carries no provenance. This one is built and published by the release workflow over npm trusted publishing, so `npm audit signatures` can verify each tarball came from this repository, from `main`, from the workflow that claims it.
  
  No code changed. The difference is what an adopter can prove about what they installed.
- Updated dependencies [[`dfda7b2`](https://github.com/pithy-sh/pithy/commit/dfda7b25c897f3fe30ad7d498dde1216a25edc09)]:
  - @pithy-sh/core@0.1.1

## 0.1.0

### Minor Changes

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

- [`280c41c`](https://github.com/pithy-sh/pithy/commit/280c41cf562a43d0ec3b84b904b18b3c8b816e9a) Thanks [@kingmesal](https://github.com/kingmesal)! - `useNegotiatedLocale` takes the object a browser actually holds.
  
  It took `I18nConfig` — the **server-side** config, carrying the catalogs, the cookie name and the server resolver chain. A browser holds `virtual:pithy/i18n`'s projection, which has none of those, and whose `browserResolvers` is `string[]` rather than the resolver enum. `packages/i18n/README.md` showed the projection being passed anyway, and that line did not typecheck.
  
  It takes `I18nClientProjection` now, which is what the hook already read: `queryParam`, `storageKey`, `browserResolvers`, `supportedLocales`, `exceptions`, `defaultLocale`. Nothing is lost — `messages` was always an option rather than read off the config — and the five lines every adopter wrote to widen one into the other are gone.
  
  `{ enabled: false }` is a real branch rather than a cast: a project that never composed `i18n` renders the English it was scaffolded with, which is what makes the capability optional.
  
  **This changes an exported signature.** `resolveBrowserLocale`, `resolveChain` and `readBrowserSignals` move with it. Nothing is published yet, so this lands as a minor rather than a major; the day a version is cut, a change of this shape is a breaking one.

### Patch Changes

- [`157bb56`](https://github.com/pithy-sh/pithy/commit/157bb5660cd6429c45d617ae79258b7bbcd872a3) Thanks [@kingmesal](https://github.com/kingmesal)! - Adding a language to email costs no configuration.
  
  **The send Worker is now built with the kit's own email copy rather than sent it.** It is a separate deploy with no request and no access to `pithy.config.ts`, so anything it does not bundle has to be stamped into it as a variable — and the kit's own Spanish was doing exactly that, on every provision run, filling 61% of Cloudflare's 5120-byte per-variable ceiling with data that changes only when the kit releases. Held beside the English it translates, the host is deployed with it and a project that overrides nothing deploys no catalog variable at all.
  
  **What travels is your diff.** Override one `email/` sentence and one sentence travels. Add a locale the kit ships and nothing travels, which is the property that makes adding languages free: the ceiling is no longer reachable by anything the kit writes, only by an override set large enough to outgrow a variable on its own.
  
  **A kit sentence still lives in exactly one place, and which package that is now follows how it reaches a reader.** `@pithy-sh/i18n` keeps what no capability can hold — the error taxonomy, whose domains are not capability names, and the screens, which are copied into an adopter's repository rather than imported. A capability keeps its own domain in every language, which is what `Capability.messages` already meant and what the domain rule already said. It also keeps principle 4 intact in both directions: no capability imports another, which a dependency edge for this data would have broken.

- [#461](https://github.com/pithy-sh/pithy/pull/461) [`067355c`](https://github.com/pithy-sh/pithy/commit/067355c9eb378744ea2f98a368a5f46a07e74fca) Thanks [@kingmesal](https://github.com/kingmesal)! - The documentation is on `pithy.sh/docs`, and the kit now says so.
  
  Every package README is a front door: what it is, `pithy add <name>`, and the link. 3,749 lines became 509. Five documents the site fully carries are retired, and the rest each carry a line naming the page that renders them.
  
  What stays, and why, is now one rule in `CONTRIBUTING.md`. A document a test reads off disk is specification rather than documentation — `docs/CLI.md`, the twenty-six command pages, `docs/NAMING.md`, `docs/I18N.md` — so it does not move. A document something here names reaches an adopter through a config error, so it stays where it is: eight under `docs/` and the per-package pages a manifest, a catalog entry or a source comment sends a reader to. `docs/BRAND.md`, `docs/CONVENTIONS.md` and `docs/STACK.md` are neither, because they are written for a contributor and the site does not render them.
  
  `docs/DEPLOY.md` is the fifth retirement and the only one that was also wrong. It said the scaffold is a single Worker with `wrangler.jsonc` at the root and that deploy falls back to it — but `templates/starter/apps/` is the scaffold and `scaffoldWorker` stamps into `apps/<name>/`, so the fallback it described has no scaffold to catch. Nothing in the repository read it; `docs/commands/deploy.md`, `docs/commands/migrate.md` and `docs/UI.md` linked to it, and all three now point at the site.
  
  The kit also exports what it contains. `docs/catalog.generated.json` names every capability, every command's flags and every error code the kit defines, so the site's docs check reads a value instead of a regular expression over TypeScript — the read that once lost `i18n` to a character class with no digits in it. CI fails on a stale one, because a stale export does not fail the site's check: it passes every page against a kit that has moved.
  
  `globalFlags` names the six flags parsed outside any command's `args` — `--help` and `--version` in both spellings, and the hidden `--pithier` and `--pithiest`. It is composed from the modules that answer them rather than listed, because the hidden pair was missed on the first pass and a list would have gone stale again on the seventh. Hidden from `--help` is not hidden from a docs check: `docs/commands/alias.md` documents both, and an export without them makes a page the kit's own tests pin read as citing flags that do not exist.
  
  `commands[].flags` carries every spelling citty answers to, not only the declared one — the camelCase form of a kebab-case name, and `--no-<name>` on a boolean. Both are citty's own behavior rather than ours, and both were false failures waiting to happen: `docs/commands/ui.md` puts `[--auth | --no-auth]` in its synopsis and `ui.ts`'s own description offers `--no-auth for the bare SPA`, so an export without it reported the most carefully written pages as the wrong ones.

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
- Updated dependencies [[`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64), [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64), [`bd6b339`](https://github.com/pithy-sh/pithy/commit/bd6b339d155ee5ec0746f42f5fb0e39d21a8f33d), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`84beb3b`](https://github.com/pithy-sh/pithy/commit/84beb3b050b9f3643cfee9a11578a780cabd08df), [`35aabdd`](https://github.com/pithy-sh/pithy/commit/35aabdd1f1153ac0ccedff35f224cf9ac596daa2), [`5e93279`](https://github.com/pithy-sh/pithy/commit/5e9327927c0f59e1d94387f2880ddba0043ec600), [`d597eb3`](https://github.com/pithy-sh/pithy/commit/d597eb3c6f07c8bb47f5c00c19f7402f8327a46d), [`e04870f`](https://github.com/pithy-sh/pithy/commit/e04870fab31169f0721e9625ef8609f66a0a9f5d), [`a75a932`](https://github.com/pithy-sh/pithy/commit/a75a932b642026ed146f24bf63914ce6f0d8943f), [`da4525b`](https://github.com/pithy-sh/pithy/commit/da4525b6097fb2f8eca3a06b4a0e02ad66634b3d), [`550252e`](https://github.com/pithy-sh/pithy/commit/550252e8304bc1f9a6bf94d440c50f8a6b974616), [`3a75222`](https://github.com/pithy-sh/pithy/commit/3a752227e5030eb8f01668e1540a057b26cad163), [`7eef492`](https://github.com/pithy-sh/pithy/commit/7eef492699697a1c964da9d54059caef54c51ff9), [`704f8fa`](https://github.com/pithy-sh/pithy/commit/704f8faf6e94aafe115df7d74ac34b1f868b211f), [`57c6df1`](https://github.com/pithy-sh/pithy/commit/57c6df11e5e553de8b034aba66db929dbd165c3e), [`0f912a2`](https://github.com/pithy-sh/pithy/commit/0f912a2677ea731d16659cf6d3f5e98b11d3c53f), [`16115c4`](https://github.com/pithy-sh/pithy/commit/16115c463287cd9222aaa05f9658020e43ec41b7), [`2d014a2`](https://github.com/pithy-sh/pithy/commit/2d014a29940281261a79deaba2d24a61339e3d80), [`1cf67d1`](https://github.com/pithy-sh/pithy/commit/1cf67d1a8f6e94be70643d6e3c4779eb0913612c), [`3ad79d5`](https://github.com/pithy-sh/pithy/commit/3ad79d588d0dbac87003bdbf452443775529d7a3), [`df8362f`](https://github.com/pithy-sh/pithy/commit/df8362f77007dbd9b3248785eaab0231967426ea), [`fa29441`](https://github.com/pithy-sh/pithy/commit/fa294411c8169e47f639c92e915fb248110bac08), [`19312ab`](https://github.com/pithy-sh/pithy/commit/19312aba66567a06fa46ef3394711eadd3f8bd1e), [`ffb4dfe`](https://github.com/pithy-sh/pithy/commit/ffb4dfe135a3b3bb306d9ba7a14aaa7103db14e2), [`de57027`](https://github.com/pithy-sh/pithy/commit/de57027baf1d17e3554ba7da0821224fc2457bb1), [`84e3325`](https://github.com/pithy-sh/pithy/commit/84e332579c3ce5ac2c8e0d4f5e7134a4d8105413), [`513483b`](https://github.com/pithy-sh/pithy/commit/513483b8476fd6c32ea5e880211b869a2bb8a7cb), [`3bca514`](https://github.com/pithy-sh/pithy/commit/3bca514e9bfbe1bab8ddc62a8da622af252780ea), [`5f1dd10`](https://github.com/pithy-sh/pithy/commit/5f1dd10965494118a94ef5f0f11c1fd8726b9674), [`fc7f19f`](https://github.com/pithy-sh/pithy/commit/fc7f19f6a4248eef00c98d6e907a14846a99a169), [`6e3c977`](https://github.com/pithy-sh/pithy/commit/6e3c977fe0aa7d0644aeac8a07c4032b5432d764), [`fe6081a`](https://github.com/pithy-sh/pithy/commit/fe6081a7d517789e81b7772ed2dea7a56a2fb745), [`bc3c8ec`](https://github.com/pithy-sh/pithy/commit/bc3c8ec8efb26028878aaf5bac1d276ff159149e), [`cd5c150`](https://github.com/pithy-sh/pithy/commit/cd5c1504739fbf39513cd5b0dc469093007df903), [`5ff5dd1`](https://github.com/pithy-sh/pithy/commit/5ff5dd1ad98c9ab469436c7fa2425e38c0662a18), [`b1bf0fb`](https://github.com/pithy-sh/pithy/commit/b1bf0fbee38e1f2e3854b529502e8046f7327f49), [`bc1ddf1`](https://github.com/pithy-sh/pithy/commit/bc1ddf137d253790dc74633b09cb505fb1865bd6), [`47e40ff`](https://github.com/pithy-sh/pithy/commit/47e40ff274e03100da64b87f5af190bf3025f2e4), [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27), [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27), [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc), [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc), [`0133b53`](https://github.com/pithy-sh/pithy/commit/0133b53ccec0eb03664bb3ff289a19f4c716d33c), [`8c90e2c`](https://github.com/pithy-sh/pithy/commit/8c90e2c5b22b5a16e8372450af0d8068cfdacd29), [`4ef5951`](https://github.com/pithy-sh/pithy/commit/4ef595178dddfc38e128f16c560cb9aa7769f1ae), [`05fb8b4`](https://github.com/pithy-sh/pithy/commit/05fb8b4c83d0cd2aa923709cc0dac00010b1971d), [`55af6d2`](https://github.com/pithy-sh/pithy/commit/55af6d2e421b8f476901e914124648e0c0ba0334), [`802513a`](https://github.com/pithy-sh/pithy/commit/802513a473828eee404b08d328a912b6b1faa8a4), [`31a7620`](https://github.com/pithy-sh/pithy/commit/31a7620a6bc5a05d43a4ec00cb4395af28fff0a5), [`2337456`](https://github.com/pithy-sh/pithy/commit/2337456baed2faba0372d19d88489eb4ad80254b), [`31dd6e9`](https://github.com/pithy-sh/pithy/commit/31dd6e935b157a5dac4d23eec9ca2f5b60b4f3b3), [`1071ace`](https://github.com/pithy-sh/pithy/commit/1071aceaad8a9d9e4acc9ac8b14c239cdc6ffe31), [`c9f2016`](https://github.com/pithy-sh/pithy/commit/c9f2016f3472213f9360bce740cac969f1efb632), [`a9d0368`](https://github.com/pithy-sh/pithy/commit/a9d0368637888d18a136251e41e97de3dd08347b), [`818a596`](https://github.com/pithy-sh/pithy/commit/818a59624d1b2fa4370cd713abb66f3bdbbc746f), [`829ead9`](https://github.com/pithy-sh/pithy/commit/829ead903f8b41574f3581d659761e88a2d56d9a), [`b9219d8`](https://github.com/pithy-sh/pithy/commit/b9219d83ab90b7bc69ede9b590f2cc7ee5855d35), [`2bfb410`](https://github.com/pithy-sh/pithy/commit/2bfb41068b43979e5ff127b20bb5193b7a724410), [`aaaeeff`](https://github.com/pithy-sh/pithy/commit/aaaeeffce8e921e2dbf71e946768cffd1da6cace), [`bb65b40`](https://github.com/pithy-sh/pithy/commit/bb65b409a2c1fcdf262de7d39c00314ff135979c), [`dd224b1`](https://github.com/pithy-sh/pithy/commit/dd224b1aeffcb0bc9b0c105015acc5b460817d94), [`3c8ffb3`](https://github.com/pithy-sh/pithy/commit/3c8ffb30480595354e83447c8dda2e2e9611f4a1), [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f), [`fcb9502`](https://github.com/pithy-sh/pithy/commit/fcb950247371ca44c978b600d5bc1bdbd72b93b9), [`1f6afb8`](https://github.com/pithy-sh/pithy/commit/1f6afb89661b03639018c6854616d8a26931d24b), [`c645d19`](https://github.com/pithy-sh/pithy/commit/c645d190022da1bde420d1f03c30bbd98f007234), [`c58405e`](https://github.com/pithy-sh/pithy/commit/c58405ef35bf57cbd0ddf70c5f8651bba90d6b4f), [`67d2cc4`](https://github.com/pithy-sh/pithy/commit/67d2cc4633f0fd66e328092e2aabce1dead48713), [`5668f08`](https://github.com/pithy-sh/pithy/commit/5668f0874a8df0fa9ad8477f3e1b48b46c181054), [`a4ab423`](https://github.com/pithy-sh/pithy/commit/a4ab423f07fd8d77061930c602444d5e9562d208), [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5), [`288848e`](https://github.com/pithy-sh/pithy/commit/288848e849f2aadf1f9444b3db03d94b781a0e1b), [`d74ce14`](https://github.com/pithy-sh/pithy/commit/d74ce140f5c19848eb7415d6b6ee86815107f83c), [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f), [`af1871b`](https://github.com/pithy-sh/pithy/commit/af1871b7e467d4e69e287038deaa0023e9c94ac3), [`e92a9a0`](https://github.com/pithy-sh/pithy/commit/e92a9a0d3658745909e36d7d4c42a53716351653), [`535755a`](https://github.com/pithy-sh/pithy/commit/535755a799a16e290b745eb18cf50aba6113bbbe), [`a9fe34f`](https://github.com/pithy-sh/pithy/commit/a9fe34f7d3a1ec4bb881de3604b0f37d7ebcf982), [`f238b0a`](https://github.com/pithy-sh/pithy/commit/f238b0a63d16608bf203ffc763f800f29d535a80), [`b22db91`](https://github.com/pithy-sh/pithy/commit/b22db91d2dcd39b4c95bd53f082c98e5df952fff), [`0ad7c74`](https://github.com/pithy-sh/pithy/commit/0ad7c744a8898824e1dc9de075afec7dd81f079a), [`4b57172`](https://github.com/pithy-sh/pithy/commit/4b57172c27bf872d751f1bbe48eff412aedb9c02), [`2811006`](https://github.com/pithy-sh/pithy/commit/2811006b836a63d56002e0858ec6db697698807e), [`d42946d`](https://github.com/pithy-sh/pithy/commit/d42946d4ad2c6b78240fb99f29fb85dc5ff30ae2), [`309a384`](https://github.com/pithy-sh/pithy/commit/309a38476c57f4d33e01f67cc08f06436bf292e2), [`5dc508a`](https://github.com/pithy-sh/pithy/commit/5dc508a20d19c6e03beca35b799df8df9e772252), [`241ce03`](https://github.com/pithy-sh/pithy/commit/241ce0371d16cd9883ac7fdb7badc04247ca3a04), [`fdba68c`](https://github.com/pithy-sh/pithy/commit/fdba68c1daffe094d566b0f37ba305ca2f715f85), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`e5b8a60`](https://github.com/pithy-sh/pithy/commit/e5b8a6072612d8e0a331833c0bc6e2b7c86b9ce4), [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f), [`5d69fb5`](https://github.com/pithy-sh/pithy/commit/5d69fb57c06d6a8d28a2bce43ccc3cf6e0c04097), [`d60788a`](https://github.com/pithy-sh/pithy/commit/d60788ac98e4317368156bdac438cebd621788a2), [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6), [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503), [`532e438`](https://github.com/pithy-sh/pithy/commit/532e4381fe863d723734cb16841411d5d7541c52), [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a), [`24ae9cd`](https://github.com/pithy-sh/pithy/commit/24ae9cd339894399b424506902bcf7076ff6530b), [`b84ec9e`](https://github.com/pithy-sh/pithy/commit/b84ec9ec2b785d4756067f6fdc8c4780bf978e1e), [`0bb29e2`](https://github.com/pithy-sh/pithy/commit/0bb29e26617e3003ea1229415b623e0bb658f205), [`3c011eb`](https://github.com/pithy-sh/pithy/commit/3c011eba0febe0f9c2a179388e48905beae17e1e), [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5), [`3a65e71`](https://github.com/pithy-sh/pithy/commit/3a65e71641d23d34a73d0b73128c7c02f0e65410)]:
  - @pithy-sh/core@0.1.0
