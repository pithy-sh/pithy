---
"@pithy-sh/cli": patch
---

Both scripts CI plans with are type-checked, and the constraint that keeps them runnable is asserted.

`.github/scripts/` was covered by no `tsconfig`, so `turbo run typecheck` checked neither
`planShards.ts` nor `crossPackageReads.ts`. Biome parsed them and CI ran them; nothing looked at a type.
That was thin cover while both imported two `node:` builtins each, and #211 ended it by giving
`planShards.ts` an import **across the tree** into `packages/cli/src/ci/sourceFiles.ts` — a module three
issues have now changed. The failure mode is specific: a rename there breaks the planner, and nothing
says so until the `plan` job fails. That is the job which decides which tests run, and a gate that
cannot be planned is a gate that does not run (#148, #173).

They are a fourth program in `packages/cli` now — `tsconfig.ciScripts.json`, alongside the second and
third that exist for the same reason. **It lives there rather than at the repo root because this
repository installs isolated rather than hoisted**: the root `node_modules` holds seven entries and
neither `typescript` nor `@types/node` is among them, so a `tsconfig` in `.github/` would resolve its
compiler and its `node` types from nowhere. `packages/cli` is where both are, and it is the package the
scripts reach into, so the program that checks the import owns the module being imported.

A deliberate type error in each script fails `turbo run typecheck`, and so does an arity change on the
symbol `planShards.ts` imports across the tree — which is the acceptance criterion this exists for.

**One seam had to be closed with it.** A turbo task's default inputs are the files in its own package,
so editing `.github/scripts/planShards.ts` alone would have hit a cached `typecheck` and reported a pass
on source it never compiled. `@pithy-sh/cli#typecheck` names those files as extra inputs. Measured both
ways on turbo 2.10.7: with the entry, a byte changed in `planShards.ts` moves the task hash; without it,
the hash is identical.

**The program must not license an import the `plan` job cannot have.** That job runs before
`bun install`, deliberately — a dry run reads the workspace manifests and nothing else — so the scripts
may import builtins and relative paths and nothing else. A type check resolves a bare specifier through
`node_modules` perfectly happily, which is exactly how a green typecheck could hand CI a script that
throws before it plans anything. So the closure is asserted rather than assumed: every module reachable
from either entry point, every specifier in each of the four spellings that reach a module, and the
graph written down as well as derived. Three modules, five distinct specifiers, no bare one. Adding
`import { z } from "zod"` to `planShards.ts` fails it by name.
