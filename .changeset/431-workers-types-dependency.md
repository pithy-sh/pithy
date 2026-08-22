---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/vector": patch
---

Seventeen packages import `@cloudflare/workers-types` and now declare it. It was a devDependency in every one of them.

`@pithy-sh/core` got this right at #315, and `tooling/browser-scopes/src/probe.ts` wrote down why in two halves: importing a package by name is what makes the dependency real, and declaring it as a dependency rather than a devDependency is what makes it satisfiable. Fourteen packages had the first half and not the second. Three more had neither. The entry moves section; the range stays `^5.20260729.1` verbatim, and the root `overrides` pin is untouched.

**The reason it never bit here is not the reason the issue gave.** The issue said a published tarball ships bundled `.d.ts` from tsdown with the types inlined, so an adopter never asks. Nothing in this repository uses tsdown. No package publishes typings from `dist`; every one declares `"exports": { "./src/*": "./src/*.ts" }`, so **every** adopter compiles our raw TypeScript inside their own program — and a devDependency of ours is not installed for them. That makes the fault wider than the `pithy init` case the issue described, not narrower. What actually hid it is local: Bun hoists the workspace and the root pin gives every member one copy, so a sibling's devDependency resolves for everything in this tree. `docs/STACK.md` has prescribed `bun add zod @cloudflare/workers-types` — `bun add`, not `bun add -d` — the whole time. The manifests drifted from it one copied sibling at a time.

Seventeen tarballs therefore gain a runtime dependency, `@pithy-sh/cli`'s among them, and the Workers types are several megabytes of `.d.ts`. That is the correct size for a package that publishes source importing them.

**Two keep theirs as devDependencies**: `turnstile` and `tooling/vite-adopter`. Neither reaches a Workers type at all — turnstile's verifier is a `fetch` to Cloudflare's siteverify endpoint and the `Response` it reads is a global every Node program has, and vite-adopter is a compile fixture rather than a published capability. Promoting them would put that payload in two adopters' installs for nothing.

**Nineteen files were not importing anything, and that is the half an import-by-name gate cannot see.** They put a Workers global in a signature — `D1Database`, `D1Meta`, `D1PreparedStatement`, `D1Result`, `KVNamespace`, `DurableObjectNamespace`, `ExecutionContext`, `ForwardableEmailMessage` — resolved through `types` in each package's own `tsconfig.json`. An adopter compiling that source gets `Cannot find name`, exactly as they would on a missing import, while every gate reads the package as clean. They import the names now: `audit`, `auth`, `cli`, `cloudflare`, `core`, `email`, `matchmaking` and `rating`.

`packages/cli/src/ci/workersTypes.test.ts` is the gate, and it holds three directions: a package that imports the types declares them, a package that does not import them does not, and **no shipped source anywhere in the workspace names a Workers global it did not import**. That last record is empty, and empty is the assertion — a file that stops importing a name it still uses lands back in it and fails.

The sweep only means that because it reads every workspace member. Its first draft read the two packages that declare the types without importing them, which is 2 of 25, and reported the tree clean while thirteen files were not; `packages/matchmaking/src/data/tables.ts` was byte-for-byte the shape `packages/rating` had just been fixed out of. It is also self-widening, which it demonstrated twice: `D1Result` was invisible because the only named import of it in the tree was in a `.test.ts`, and importing it in one file made the second file naming it ambiently fail immediately.

A name the host platform declares is excluded, and the host is asked rather than listed — `ReadableStream` enters the vocabulary because `@pithy-sh/storage` imports it by name, and casting `Response.body` to it is not the ambient defect in any runtime. `name in globalThis`, measured against the Node 22 floor every package states.

The gate is scoped to this one specifier. The general rule — every bare specifier a shipped source imports is a declared dependency — is the shape, and the docblock says why it is not asserted yet: the same sweep finds `vitest` and `miniflare` reached from `src/test-utils/*.ts` files that ship because nobody excluded them, and making a test framework a runtime dependency of the CLI would be the wrong answer to that.
