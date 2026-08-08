---
"@pithy-sh/cli": patch
---

One walk over this tree's source, so a tripwire cannot flake on somebody else's teardown.

`project/atomic.test.ts`'s rename tripwire read every source file in the repository and descended into `packages/cli/.smoke-*` and `.e2e-*` — whole projects other suites scaffold and delete while it walks — and into `.worktrees/`, a second checkout of this repository read as if it were this one. A full-suite run failed with `ENOENT … packages/cli/.smoke-OXGbGb/pithy.config.ts`. Timing-dependent, so it passes locally and fails in CI or the reverse, which is the worst shape for a gate whose job is to fail the build honestly. A tripwire that flakes gets muted, and a muted tripwire is the defect it was built to catch, shipping.

Every reader of this tree's own source now goes through `packages/cli/src/ci/sourceFiles.ts`. It skips dotted directories — `.github` excepted, since its scripts are source CI runs — never descends a symlink, and treats a directory it cannot list and a file that vanished between the listing and the read as skipped rather than fatal. A file that is not there is not a file that breaks a rule.

Migrated: the rename tripwire (`project/atomic.test.ts`), the follower and recursive-delete tripwires (`project/scaffold.test.ts`), the editor tripwire (`platform/editor.test.ts`), the runtime-export gate (`capabilities/configEntrypoints.test.ts`), and CI's change planner (`.github/scripts/crossPackageReads.ts`), which still imports nothing but `node:fs` and `node:path` so it runs before `bun install`.

Six traversals were six places to get the same two things wrong separately, and they had: #157's was hardened when it was written and `atomic.test.ts`'s was not. There is one now, and it has its own tests.
