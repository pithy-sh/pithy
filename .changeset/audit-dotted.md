---
"@pithy-sh/cli": patch
---

The source walker can be told to enter a dotted directory, and the license audit's reach is checkable.

`sourcePaths` skips dotted directories, and that rule is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every tripwire in this repository. It had no opt-out, and `keep` narrows which *files* are taken while nothing widened which *directories* are entered. `dotted: true` is that opt-in — **off by default, so every existing caller keeps the rule protecting it**, and it widens the dotted rule and nothing else: dependencies, build output, the caller's own `skip`, the vendored `packages/cli/templates` copy and a symlinked directory are all still refused with it on.

That matters for the shape of question the license audit asks. It is not asking about this tree's source; it is asking whether every file a template *ships* carries the right header, and a template that grew a `.vscode/`, a `.husky/` or a `.github/` would ship every file in it unchecked while the audit reported clean. No template holds a dotted directory today — two dotted files, which were never affected — so this is latent rather than live, and it is the shape this repository keeps producing: a gate whose reach is narrower than the rule it enforces.

**Both walks in `tooling/license-headers` do enter one, and now something says so.** `audit.test.ts` plants a stamped file inside `packages/ui-react/templates/.vscode/` and `templates/starter/.husky/deep/` and requires both reported as `unexpected-header`; a second plants an unheadered `packages/core/src/.generated/client.ts` and requires `missing-header`; `workspace.test.ts` asserts the same reach directly. Each fails if either walk starts skipping a dotted directory. Without that, the next narrowing is invisible again.

**One reason in the exception list is corrected, and this time it leaves.** #202 said `audit.ts` could not use the shared walker because of the `templates` skip; #211 checked that and found it false — the primitive skips `packages/cli/templates` by path and nothing else, and that path is a byte-for-byte copy existing only between `prepack` and `postpack`. #211 recorded the real blocker, the dotted-directory skip, and it is closed here. What keeps that walk separate now is direction alone, the same reason as its neighbor: `tooling/license-headers` is the gate that stamps `packages/cli`'s own headers and it runs in `lint-staged` on every commit, so making the linter a dependent of the largest thing it lints points the graph backwards.
