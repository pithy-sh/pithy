---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
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
"@pithy-sh/turnstile": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

Every package now ships JavaScript with declarations beside it, so node can import the kit.

`exports` pointed at `./src/*.ts`. That works for every consumer with a bundler — wrangler, Vite, vitest transforming a test — and fails for the one with none: node, which refuses to strip types under `node_modules` and cannot be argued out of it. An adopter's `vitest.config.ts` importing `@pithy-sh/vite` died there with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and so would any Node script that touched the kit.

Each package builds with tsdown for the JavaScript and `tsc --emitDeclarationOnly` for the types. Two tools because each does one half well: tsdown resolves relative imports to real extensions and leaves siblings external, so `core` is not copied into the twenty packages that depend on it, while its own declaration bundling would flatten `src/error/pithyError.ts` to `dist/pithyError.d.ts` and break the `./src/*` deep-import surface. `tsc` mirrors the tree exactly, so `@pithy-sh/core/src/error/pithyError` keeps resolving to the same path it always named.

**The import path an adopter writes has not changed.** `exports` still keys on `./src/*`; it resolves onto `./dist/*.js` and `./dist/*.d.ts` now instead of onto the TypeScript. Source still ships, because the declaration and source maps point back into it — stepping into the kit lands on the file it was written in.

Two gates were added rather than assumed. `bun run clean-room` imports the packed kit with plain `node` and requires a declaration beside each module; pointing one package's `exports` back at raw TypeScript fails it with the original error. And `bun run verify-published` refuses a tarball that carries no build, or a published module with one half of its pair — a `.js` with no `.d.ts` is an `any` in the adopter's editor, and a `.d.ts` with no `.js` is a type that cannot be imported.
