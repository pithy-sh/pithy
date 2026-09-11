---
"@pithy-sh/audit": minor
"@pithy-sh/auth": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/i18n": minor
"@pithy-sh/leaderboard": minor
"@pithy-sh/ledger": minor
"@pithy-sh/matchmaking": minor
"@pithy-sh/media": minor
"@pithy-sh/multiplayer": minor
"@pithy-sh/payments": minor
"@pithy-sh/rating": minor
"@pithy-sh/secrets": minor
"@pithy-sh/storage": minor
"@pithy-sh/support": minor
"@pithy-sh/testers": minor
"@pithy-sh/turnstile": minor
"@pithy-sh/vector": minor
"@pithy-sh/vite": minor
"@pithy-sh/cli": patch
---

A shared `@pithy-sh/*` package is a `peerDependency`, so a project cannot end up holding two copies of one.

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
