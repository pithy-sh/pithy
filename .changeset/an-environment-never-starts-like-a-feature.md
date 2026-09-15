---
"@pithy-sh/core": minor
---

An environment can no longer be named the way a feature is.

A feature Worker is `<project>-f<issue>-<slug>-<app>`, with no kind suffix. #587 made that exactly the shape a
declared environment's Worker takes, `<project>-<env>-<app>`, whenever the environment is called
`f<issue>-<slug>`. Nothing reserved that shape, so `pithy feature destroy` on `feature/1-demo` deleted the
`f1-demo` environment's live Worker, and `pithy provision --feature` pointed a deploy at it.

**An environment whose first segment is `f` and digits is refused** — `f1`, `f1-demo`, `f01`. That is the whole
set that can collide, and nothing else is refused: `fr-1`, `f1a` and `fix` compose no name a feature can. A
project that declared one is told so by `DeclaredEnvironments`, and has to rename it.

**`environmentScope` refuses a Worker name inside a feature's namespace**, whether its stanza declares it or
wrangler composes it from the deploy name, because neither is built from the environment name.

`isFeatureName`, `featureMarker` and `isFeatureMarker` are exported from `@pithy-sh/core`'s naming modules.
