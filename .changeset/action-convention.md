---
"@pithy-sh/cli": patch
"@pithy-sh/vite": patch
---

Twenty refusals named a remedy their `catch` could not know.

#207 fixed one: a `pithy.config.ts` that would not load told every adopter to run `bun install`, whether the failure was a missing dependency or a stray brace. The survey it asked for found twenty more of the same shape — a `catch` reachable by more than one underlying failure, whose `action` names one specific remedy. A wrong action is worse than no action, because it is followed.

Fourteen were the identical line in seven capability loaders: several `import()` calls in one `try`, and `action` was always ``Run `pithy add <cap>` ``. That is wrong precisely when the capability **is** installed and one of its own transitive dependencies is not — #207's bug, one level down the graph. `classifyCapabilityLoadFailure` now decides between the capability being absent, a dependency of it being absent, the package being present and broken, and not knowing — and the last of those names no remedy at all.

The other six each answered their own way. `pithy feature`'s registry and manifest readers said *check permissions* for every errno that is not `ENOENT`, including a directory sitting where the file belongs. `resolvePortsRegistryPath` said *run pithy from inside a git repository* to a machine with no `git` on `PATH`. `pithy ui`'s `package.json` reader and `pithy add --eject`'s manifest reader each wrapped a read and a parse in one `try` and asserted absence — `pithy ui` also merged into whatever parsed, so a `package.json` holding `[]` would have been written back as an array with dependencies hung off it. The dashboard client answered a timeout, a DNS failure, a refused port, an expired certificate, a 401 and a 500 with *check the dashboard origin with --origin*. `@pithy-sh/vite`'s config loader carried #207's defect verbatim and now classifies the same four ways.

Everything that reads a cause is duck-typed. The `bin` ships on Bun, whose `ResolveMessage` and `BuildMessage` are not `instanceof Error`, and vitest runs on Node — so an `instanceof` gate passes the whole suite and drops the parser's sentence on the only runtime adopters use. That is how #207 shipped its first implementation, and it is why the classifiers are exported and tested directly against both runtimes' real shapes.

The rule is written down in `docs/CONVENTIONS.md`: **if a `catch` can be reached by more than one underlying failure, `action` may not name a single specific remedy.** Classify, or hedge. `capabilities/manifests.ts` worked that out first and left it in a comment in one file, where it stayed. Twenty is why it is a convention now and not a twenty-first patch.
