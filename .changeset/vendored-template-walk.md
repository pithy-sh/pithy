---
"@pithy-sh/cli": patch
---

The source walk no longer reads the starter template twice while a pack is in flight.

`packages/cli/templates` is the copy of the repo root's `templates/starter` that `prepack` vendors in and `postpack` takes out again. It is not dotted, so the walk in `ci/sourceFiles.ts` descended into it and reported five template sources under two paths at once — the real one and the copy. Every tripwire that reads this tree's own source got a different answer depending on whether a pack was running: the rename tripwire, the recursive-delete and follower tripwires, the `$EDITOR` gate, the runtime-export gate, and CI's change planner, which would have picked up the starter's own `bindings.workers.test.ts` as a `packages/cli` test file and planned suites on it.

It cannot be dotted and it cannot move. `files` in the CLI's manifest carries exactly that path, and that is the whole mechanism by which a published `@pithy-sh/cli` ships a starter at all (#143, #152). So the walk skips it by where it is — by path, never by name, because the repo root's `templates/` is the source of truth those same tripwires exist to read.

Skipping is right whether or not a pack is running. It is a file-by-file copy of a directory the walk already visits, so descending into it can only ever report a source twice, under a second path that `postpack` is about to delete. A pack that fails after `prepack` never runs `postpack` and leaves the copy behind for good — gitignored, so `git status` says nothing — and then the duplicate is permanent rather than transient. Nothing flaked today because no template source breaks a rule; the one that eventually does would have gone red or green on timing, naming a file nobody could open (#192).

`bun run pack:verify` and `packaging.test.ts` are unchanged.
