---
"@pithy-sh/cli": patch
---

The gates that assert about other packages' files run on the PRs that change those files.

`--affected` maps a changed file to its owning package and that package's dependents. That is the
whole model, and a test asserting about **another** package's files is invisible to it.
`packages/cli` is no dependent of `packages/leaderboard`, so editing
`packages/leaderboard/pithy.manifest.json` planned `leaderboard, multiplayer` — measured, `count: 2`
— and the sweep in `capabilities/reconcile.test.ts` holding every shipped manifest default to 120
columns did not run on the change it exists to gate. Green, and unverified.

That is the second time this shape landed. #148 was the same defect on `templates/starter`, closed by
hardcoding `^templates/` in the workflow, and this one was found on the branch that closed it — a
hand-maintained list being another place to forget is not a hypothetical here, it is the history.

So nothing is hardcoded now. `.github/scripts/crossPackageReads.ts` derives the mapping from the
tests themselves on every run: it resolves the relative-path literals in each package's test files
and keeps the ones landing outside the package that owns them. Eight paths, one package, no list —
`packages/leaderboard/pithy.manifest.json` now plans `cli, leaderboard, multiplayer`, and
`templates/starter/pithy.config.ts` still plans `cli`. A read added tomorrow is planned tomorrow.

The resolved path has to exist on disk, which is the rule separating a path a test reads from one it
rejects: `testers/src/crypto/token.test.ts` feeds `"../../../etc/passwd"` to a traversal guard as
hostile input and never opens it.

Not turbo's own knobs, and this was measured on turbo 2.10.7 rather than assumed.
`inputs: ["$TURBO_ROOT$/packages/*/pithy.manifest.json"]` on the CLI's `test:node` leaves the
affected set byte-identical — `--affected` never reads task inputs. `globalDependencies` does reach
the change mapper, but only for files no package owns: `templates/**` there works and escalates to
all 23 packages, while `packages/*/pithy.manifest.json` is ignored outright because those files
already have an owner. Turbo has no way to say "this path belongs to that package's tests".

`packages/cli/src/ci/crossPackageReads.test.ts` holds the derivation to a written-down set of paths,
so the next cross-package read is added by someone who meant to.
