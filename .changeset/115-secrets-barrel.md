---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

`pithy add secrets` wrote a config that could not load.

`@pithy-sh/secrets` shipped no `src/index.ts`, so the import `pithy add` writes — `import { secrets } from "@pithy-sh/secrets/src/index"` — resolved to nothing, and every later `pithy` command failed on the config rather than on the cause. The package now has an entrypoint: the capability factory, the registry helper and its schemas, the two accessors, the table map. Nothing else. `pithy eject secrets` was broken by the same gap and works now too.

A test in the CLI checks every catalog entry against the package it names — the file exists, and it exports the factory. The defect was invisible to both packages because each only ever looked at its own tree.

`add`, `remove`, and `eject` now read the config's imports through one set of rules instead of three hand-built strings. The import is found by the name it binds and acted on by where it comes from: the package, any deeper path into it, or an ejected copy. `add` refuses, before writing anything, when the name is already bound to something else — it used to wire the registration anyway and let the adopter's own module answer as the capability.
