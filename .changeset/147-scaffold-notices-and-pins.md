---
"@pithy-sh/cli": patch
---

`pithy ui add` and `pithy worker add` say what `pithy init` says when the kit range is dropped.

Both silently omitted a `@pithy-sh/*` dependency and then exited 0 — `worker add` over a `src/index.ts`
importing `@pithy-sh/core`, `ui add` over "Install the packages: npm install", which succeeds and then
fails the build on the missing Vite plugin. One function decides that wording for all three commands.

`@pithy-sh/core` and `@pithy-sh/vite` are now a Changesets `fixed` group, which is what makes the
`@pithy-sh/vite` range `pithy ui add` derives from core's version honest after the first release.

The `wrangler` pin has one home instead of three, and the two Worker producers are held to the same
dependency key *sets* rather than to a few named keys.
