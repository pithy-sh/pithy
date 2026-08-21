---
"@pithy-sh/vite": patch
---

`pithy()` no longer types its return against the kit's own copy of Vite, so the peer range is true.

`package.json` declares `vite: ^6.1.0 || ^7.0.0 || ^8.0.0`. The signature said something narrower: `Plugin`, resolved out of this package's `node_modules`. An adopter who resolved any other copy — every adopter developing against a symlinked kit, and every adopter whose install did not deduplicate — had to prove the kit's `Plugin` assignable to theirs before `plugins: [pithy()]` would compile. Across majors that fails outright; within one it does not finish, and `pithy-sh/dashboard` could not typecheck the `vite.config.ts` `pithy init` had just written for it: `TS2321: Excessive stack depth comparing types`. A peer dependency that only compiles when the install deduplicates is not a peer dependency.

`pithy()` and `pithyTest()` now return `PithyPlugin` — a named interface this package owns, promising the two things every supported Vite agrees on and an adopter's checker settles in two comparisons: the plugin has a name, and it enforces `pre`. Nothing about it is a Vite type, so nothing about it depends on which Vite an adopter installed.

The hooks are still checked. The object is written `satisfies Plugin` against the Vite this package develops against, so every hook keeps its parameter types, its `this` and its return type, and a hook that reads the wrong field is still a red build. What an adopter's checker no longer does is re-derive that against their copy — it sees two properties and takes the hooks on trust.

`tooling/vite-adopter` is what pays for the trust, and it could not live in this package: proving the rule needs two resolutions of Vite present at once, and typechecking the kit against the kit is exactly what always passed. It pins one exact copy per major in the peer range, none of them the copy the kit installs, and compiles both entry points against each. Restoring the old signature reddens it — including, at Vite 8, the same `TS2321` the dashboard reported.

It also runs a real `vite build` through the plugin at 6.1.6, 7.0.0 and 8.0.0, and reads the bundle: the projection inlined, the environment threaded, and an unprojected config value absent. Compiling against three copies proves the return type; only building proves the hooks. What crosses the range in types is the hook *set* — `PITHY_PLUGIN_HOOKS`, a new export, is held to each major's `keyof Plugin`, so a hook Vite 6 has no name for cannot ship under a range that claims 6. Hook *signatures* are checked against one Vite and cannot be checked against three: Vite 8 is rolldown-based and 6 and 7 are rollup-based, so no single object can be written `satisfies Plugin` against both.

No behaviour changed. A `PithyPlugin` is the same object Vite already received.
