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

Every distributed file carries its SPDX notice.

The source stamper has always run on `src`. Nothing stamped what is built from it — tsdown drops a file's leading comment on emit, and `tsc --emitDeclarationOnly` drops one that is not attached to a declaration — so the `.js` and `.d.ts` an adopter actually opens carried no notice while every source file did. The tarballs have always shipped `LICENSE` and declared a license, so nothing was ever unlicensed; what was missing is the notice on the artifact.

Both halves are stamped now, from **the package's own declared license**, through the same `buildHeader` that writes source. `@pithy-sh/audit` is `FSL-1.1-MIT`, so this is not a formality: a notice fixed at MIT would have put the wrong terms on its compiled output while its source read correctly.

`bun run verify-published` refuses a tarball shipping a `dist` file without one.

No code changed in this release for most of these packages — the bytes differ only by the two comment lines at the top of each built file.
