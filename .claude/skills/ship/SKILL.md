---
name: ship
description: Use to build and ship a Ready GitHub issue for Pithy, end to end, checkpointed. Takes a Ready issue, implements it with TDD, runs the real gates (typecheck/biome/vitest), runs /code-review and /security-review, opens a PR that closes the issue, captures a release note as a Changesets entry, and moves the board Status. Invoke for "/ship", "/ship #N", "build issue N", or "implement the next ready issue". Stops at two gates for your approval.
---

# ship

Build a `Ready` issue and ship it. One issue, end to end, with two approval gates.

`/ship` is the build engine. `/refine` gets an issue to `Ready`; `/ship` takes it from there to shipped. It composes existing skills rather than reinventing them — `superpowers:test-driven-development` for the work, the built-in `/code-review` and `/security-review` for the gates. It writes **no plan or design docs**: the issue is the spec; the commit (or PR) is the record.

## Current mode: solo — `main`, no branches

We are the only ones on this code right now, so `/ship` works directly on `main`: **no feature branch, no PR.** Implement on `main`, run the gates and reviews locally, then at Gate 2 commit to `main` with `Closes #<N>` (auto-closes the issue on push, and GitHub auto-sets Status → `Done`). The branch + PR path described in steps 1, 5, and 6 below is the **collaboration mode** — flip this note and switch to it the moment anyone else joins.

**`--worktree` overrides this.** `/ship #N --worktree` runs the full isolated path regardless of solo mode: a dedicated git worktree on a `feature/<N>-<slug>` branch, then push → PR → worktree teardown. The PR stays open; merging is your call (step 7). Use it to run several features at once — one terminal per worktree, feedback isolated per session. See **Isolation** and steps 1/6.

## Voice

`docs/BRAND.md` is binding for every commit, PR body, changeset, and board update. Short sentences. Deliberate periods. No fluff, no emoji. The release note reads the way it should appear in the changelog.

## Fixed facts

- **Repo:** `pithy-sh/pithy`
- **Board:** Projects v2, org `pithy-sh`, title **Pithy** (project #1, id `PVT_kwDOEV7hPs4BZ_c6`).
- **Status** single-select field (id `PVTSSF_lADOEV7hPs4BZ_c6zhU6JTk`): `Inbox · Ready · In Progress · Done`.
  - `/ship` drives: `Ready → In Progress` on start; `Done` is set automatically by GitHub when the issue closes (PR merge with `Closes #N`, or direct push to main).
  - Solo mode: the push auto-closes the issue; no manual Status → Done needed.
  - Worktree/PR mode: Status stays `In Progress` until the PR merges; GitHub sets Done.

**Resolve option IDs at runtime — always.** Single-select option IDs are **not stable**: editing a field's options reassigns every ID. Never hardcode an option ID. Project id and field id above are stable; option ids are not.

## Resolving the board (the reliable way)

`gh project item-list` lags for a while after writes — do not trust it for verification. Use these instead:

```bash
# Status option ids (re-resolve every run)
gh project field-list 1 --owner pithy-sh --format json
#   → .fields[] where .name=="Status" → .options[] {id,name}

# The board item id for issue N (lag-free, authoritative)
gh api graphql -f query='
query { repository(owner:"pithy-sh", name:"pithy") {
  issue(number: N) { projectItems(first:10) { nodes { id project { number } } } } } }'
#   → the node whose project.number == 1 → .id  (the ITEM id, not the issue number)
```

**Set an item's Status:**

```bash
gh project item-edit --id <itemId> \
  --project-id PVT_kwDOEV7hPs4BZ_c6 \
  --field-id PVTSSF_lADOEV7hPs4BZ_c6zhU6JTk \
  --single-select-option-id <statusOptionId>
```

## Flow (checkpointed — 🛑 stops for the user)

### 1. Preflight

- Resolve the target. `/ship #N` → issue N. Bare `/ship` → pick the lowest-numbered issue at Status `Ready` whose dependencies are `Done`; confirm with the user.
- Read the issue: acceptance criteria, **Release note**, **Change type**, and any plan it references (`docs/superpowers/plans/…` — read for detail; do not write to that format).
- Verify dependencies. If the issue says `Depends on #M`, confirm #M is `Done`. If not, stop and say so.
- **Assign the issue.** If it's unassigned, assign it to whoever is running `/ship`: `gh issue edit <N> --add-assignee @me`. Leave an existing assignee alone.
- **Set up isolation.**
  - Default (solo): work on `main` — no branch (see **Current mode**). Collaboration mode: create branch `feature/<N>-<short-kebab-slug>` from `main`.
  - `--worktree`: run `bun run worktree setup <N> <short-kebab-slug>`. It creates the `feature/<N>-<slug>` branch and a `.worktrees/<N>-<slug>` worktree, installs deps, and links `.dev.vars` if one exists (idempotent — no-ops if it already exists). Do **all** subsequent work — edits, gates, commit — rooted in that worktree path.
- Move Status → `In Progress`.

### 2. Implement

- Work task by task using `superpowers:test-driven-development` — red, green, refine. Follow the issue's plan where one exists.
- **TDD is recursive — don't test only at the acceptance-criteria altitude.** Drop a level whenever a unit has real logic: write *that unit's* test first, at that level, not only through the public surface. At the refactor step, when you extract a helper, give it its own co-located test (`feature.ts` → `feature.test.ts`) right then. What earns a direct test: branching logic, edge cases, error paths, anything you'd be nervous to refactor. Trivial passthroughs ride on the higher-level test — don't add noise.
- Match existing patterns exactly. No `TODO`/`FIXME`/placeholders in shipped code. No new dependencies without checking what's already there. Honor every rule in `CLAUDE.md`.
- Run the real gates until green:
  ```bash
  bun run typecheck
  bunx biome check .
  bun run test        # or: bun run --filter <pkg> test
  ```

### 3. 🛑 Gate 1 — implementation review

Show the diff summary, the passing gates, and how each acceptance criterion is met. Ask: **proceed to review?** Wait for the user.

### 4. Review

- Run `/code-review` on the branch diff. Then `/security-review`.
- **Check unit-level coverage.** Any unit with real logic that's only covered transitively (through a higher-level test) needs its own direct test — treat that as a must-fix finding. `vitest` coverage (v8) is the signal; judgment decides, not a threshold. Trivial passthroughs are exempt.
- **Remediation loop (max 2 cycles):** if either surfaces must-fix findings, fix them, re-run the gates, and re-run the failed review. After 2 cycles still failing, stop and escalate to the user with the specifics — do not loop forever.

### 5. 🛑 Gate 2 — ship review

Present the `/code-review` and `/security-review` results (and any remediation). Ask: **open the PR?** If the user requests changes, go back to step 4. Wait for approval.

### 6. Ship

- **Changeset.** If **Change type** is not `none`, write `.changeset/<slug>.md`:
  ```markdown
  ---
  "@pithy-sh/<pkg>": <patch|minor|major>
  ---

  <the issue's Release note, verbatim, brand voice>

  Security: <the issue's Security sentence — omit this line entirely when it is N/A>
  ```
  If Change type is `none`, skip — no changeset.

  **The `Security:` line is the issue's Security field, verbatim, and it goes in the body — never the frontmatter.** `@changesets/parse` reads every frontmatter key as a package name, so a `security:` key there breaks `changeset version`. Omit the line when the field is `N/A`; never invent one, and never drop one the issue states. It is what the release pipeline reads to mark the release security-relevant (`CONTRIBUTING.md` §Releases, `docs/RELEASING.md`).
- **Commit.** Conventional Commits, scoped, brand voice, with the issue number:
  ```
  feat(core): add SQLite codecs

  <short body if useful>

  #<N>
  ```
- **Sync with `main` before pushing.** Branches drift; never push/PR (or commit to `main` solo) on a stale base. Fetch and check the behind-count:
  ```bash
  git fetch origin
  git rev-list --count HEAD..origin/main   # 0 = up to date; >0 = behind
  ```
  If it's `>0`, **rebase onto `origin/main`** (`git rebase origin/main`), resolve any conflicts, then **re-run the full gates** (typecheck/biome/test) — a clean branch can still break against new `main`. Solo-on-`main`: just `git pull --rebase origin main` before committing. Re-confirm at merge time too: if `main` lands something after the PR opens, use GitHub's **Update branch** (or rebase again) before merging — GitHub's `mergeable`/`mergeStateStatus` on the PR is the signal.
- **Ship the change.**
  - **Solo, no `--worktree`:** commit to `main`; the push auto-closes the issue via `Closes #<N>`, and GitHub auto-sets Status → `Done`. Skip the PR steps below.
  - **`--worktree` (or collaboration mode):** commit on `feature/<N>-<slug>`, then:
    ```bash
    git push -u origin feature/<N>-<slug>
    gh pr create --base main --head feature/<N>-<slug> \
      --title "<conventional title>" --body "Closes #<N>

    <one-paragraph summary>"
    ```
    `Closes #<N>` auto-closes the issue on merge, and GitHub sets Status → `Done`. **Do not auto-merge** — leave the PR open; merging is the user's call (step 7). Give the user the PR link.
- **`--worktree` teardown.** Once the PR is open, run `bun run worktree teardown <N> <short-kebab-slug>` — the branch lives on the remote; the worktree is done. **Skip teardown if gates failed or the user aborted** — leave the tree in place to fix, and re-running `setup` later re-attaches to the same branch.

### 7. Done

When the PR merges (or the solo push lands), GitHub auto-closes the issue and sets Status → `Done`. No manual board update needed. Merging is always the user's call.

## Isolation: `--worktree`

`scripts/worktree.ts` (`bun run worktree setup|teardown <N> <slug>`) owns the git-worktree lifecycle. `setup` cuts `feature/<N>-<slug>` and a `.worktrees/<N>-<slug>` worktree off `origin/main`, installs deps, and links `.dev.vars` when one exists; it no-ops if the worktree already exists, and re-attaches to the branch if it survived a prior teardown. `teardown` removes the worktree the Linux-safe way — `rm <worktree>/.git && git worktree prune`, **never** `rm -rf` or `git worktree remove` (inotify storms) — and deletes the local branch only if it merged. Both are idempotent.

Run several features at once: one terminal per `/ship #N --worktree`, each its own branch, worktree, and session, so feedback never overlaps. The richer lifecycle in `CLAUDE.md` (ephemeral CF resources, the port allocator, generated `.dev.vars`) is the product Pithy is building — `pithy feature` (#25) will wrap this same script and add those layers.

## Non-interactively (agents / CI)

Works headless: `/ship #N` with no person to gate proceeds through both gates automatically only when explicitly told to run unattended; otherwise it stops and reports at each gate. Prefer `--format json` / GraphQL for every board read. Never fabricate a passing gate — if `typecheck`/`biome`/`vitest` fail, stop and report.

## Guardrails

- Requires `gh` with the `project` scope. On a missing-scope error, tell the user to run `gh auth refresh -s project`.
- Never move past a 🛑 gate without the user's approval.
- Never claim a gate passed without running it and seeing the output (`superpowers:verification-before-completion`).
- While solo (see **Current mode**), commit to `main` directly — that's the user's call. In collaboration mode and with `--worktree`, commit only on the feature branch, never to `main`. Never `--no-verify`.
- With `--worktree`, never remove a worktree by hand (`rm -rf` / `git worktree remove`) — use `bun run worktree teardown` (inotify-safe).
- One issue per `/ship`. Keep the change scoped to the issue.
- Never push/PR (or solo-commit to `main`) on a stale base. `git fetch origin` and check `git rev-list --count HEAD..origin/main`; if behind, rebase onto `origin/main` and re-run the gates before shipping (step 6). Re-check mergeability at merge time.
