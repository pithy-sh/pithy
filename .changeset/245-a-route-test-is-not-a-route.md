---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

A co-located route test is a test, not a route.

`src/router.tsx` says its two globs ARE the route registration and must not be edited. They matched `**/*.tsx`, which matches `**/*.test.tsx` — so `home.test.tsx` beside `home.tsx`, the file every other convention in the kit tells an adopter to write, was registered as a route and bundled. Measured in `pithy-sh/dashboard`: a 283 kB Vitest chunk in `dist/client/`, loaded on every page. The suite was green, because running a test was never the problem. A test file carries fixtures, stub tokens, hardcoded ids and comments about how an endpoint fails, and all of it was being served to anyone who asked.

Both globs now take an array and negate `*.test.tsx` and `*.spec.tsx` — the test runner's own names for its own files. Refusing a module with no `path` export would have stopped it *registering* and shipped it anyway; by the time that check runs the glob has already pulled the module into the graph, so the fix is the glob. `router.tsx` stays byte-identical in every template.

The other half was quieter. The starter's node test project collected `apps/*/src/**/*.test.ts`, and a scaffolded front end is `.tsx` to the last file — so the same test ran nowhere, and `passWithNoTests` made that green. It collects `*.test.{ts,tsx}` now, with the Workers-runtime exclude widened beside it.

Two gates, both proven against a planted file. `@pithy-sh/ui-react` runs a real `vite build` over the real `router.tsx` with a test planted beside a screen, and fails if any emitted asset mentions it. `@pithy-sh/cli` holds the starter's include against every extension the UI stub writes, rather than against a literal.
