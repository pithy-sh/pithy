---
name: ship
description: Use to build and ship a Ready GitHub issue for Pithy, end to end, checkpointed. Takes a Ready issue, implements it with TDD, runs the real gates (typecheck/biome/vitest), runs /code-review and /security-review, opens a PR that closes the issue, captures a release note as a Changesets entry, and moves the board Stage. Invoke for "/ship", "/ship #N", "build issue N", or "implement the next ready issue". Stops at two gates for your approval.
---

# ship

Build a `Ready` issue and ship it. One issue, end to end, with two approval gates.

`/ship` is the build engine. `/refine` gets an issue to `Ready`; `/ship` takes it from
there to shipped. It composes existing skills rather than reinventing them —
`superpowers:test-driven-development` for the work, the built-in `/code-review` and
`/security-review` for the gates. It writes **no plan or design docs**: the issue is the
spec; the commit (or PR) is the record.

## Current mode: solo — `main`, no branches

We are the only ones on this code right now, so `/ship` works directly on `main`: **no
feature branch, no PR.** Implement on `main`, run the gates and reviews locally, then at
Gate 2 commit to `main` with `Closes #<N>` (auto-closes the issue on push) and move Stage
→ `Done`. The branch + PR path described in steps 1, 5, and 6 below is the **collaboration
mode** — flip this note and switch to it the moment anyone else joins.

## Voice

`docs/BRAND.md` is binding for every commit, PR body, changeset, and board update. Short
sentences. Deliberate periods. No fluff, no emoji. The release note reads the way it
should appear in the changelog.

## Fixed facts

- **Repo:** `pithy-sh/pithy`
- **Board:** Projects v2, org `pithy-sh`, title **Pithy** (project #1,
  id `PVT_kwDOEV7hPs4BZ_c6`).
- **Stage** single-select field (id `PVTSSF_lADOEV7hPs4BZ_c6zhU6JbM`):
  `Inbox · Refining · Ready · Building · In review · Done`. `/ship` drives the back half:
  `Ready → Building → In review → Done`.

**Resolve option IDs at runtime — always.** Single-select option IDs are **not stable**:
editing the field's options reassigns every ID and clears existing item values. Never
hardcode an option ID. Project id and field id above are stable; option ids are not.

## Resolving the board (the reliable way)

`gh project item-list` lags for a while after writes — do not trust it for verification.
Use these instead:

```bash
# Stage option ids (re-resolve every run)
gh project field-list 1 --owner pithy-sh --format json
#   → .fields[] where .name=="Stage" → .options[] {id,name}

# The board item id for issue N (lag-free, authoritative)
gh api graphql -f query='
query { repository(owner:"pithy-sh", name:"pithy") {
  issue(number: N) { projectItems(first:10) { nodes { id project { number } } } } } }'
#   → the node whose project.number == 1 → .id  (the ITEM id, not the issue number)
```

**Set an item's Stage:**

```bash
gh project item-edit --id <itemId> \
  --project-id PVT_kwDOEV7hPs4BZ_c6 \
  --field-id PVTSSF_lADOEV7hPs4BZ_c6zhU6JbM \
  --single-select-option-id <optionId>
```

## Flow (checkpointed — 🛑 stops for the user)

### 1. Preflight

- Resolve the target. `/ship #N` → issue N. Bare `/ship` → pick the lowest-numbered
  issue at Stage `Ready` whose dependencies are `Done`; confirm with the user.
- Read the issue: acceptance criteria, **Release note**, **Change type**, and any plan it
  references (`docs/superpowers/plans/…` — read for detail; do not write to that format).
- Verify dependencies. If the issue says `Depends on #M`, confirm #M is `Done`. If not,
  stop and say so.
- Create branch `feature/<N>-<short-kebab-slug>` from `main`. (Branch, not worktree — see
  **Isolation** below.)
- Move Stage → `Building`.

### 2. Implement

- Work task by task using `superpowers:test-driven-development` — red, green, refine.
  Follow the issue's plan where one exists.
- **TDD is recursive — don't test only at the acceptance-criteria altitude.** Drop a
  level whenever a unit has real logic: write *that unit's* test first, at that level,
  not only through the public surface. At the refactor step, when you extract a helper,
  give it its own co-located test (`feature.ts` → `feature.test.ts`) right then. What
  earns a direct test: branching logic, edge cases, error paths, anything you'd be
  nervous to refactor. Trivial passthroughs ride on the higher-level test — don't add
  noise.
- Match existing patterns exactly. No `TODO`/`FIXME`/placeholders in shipped code. No new
  dependencies without checking what's already there. Honor every rule in `CLAUDE.md`.
- Run the real gates until green:
  ```bash
  bun run typecheck
  bunx biome check .
  bun run test        # or: bun run --filter <pkg> test
  ```

### 3. 🛑 Gate 1 — implementation review

Show the diff summary, the passing gates, and how each acceptance criterion is met. Ask:
**proceed to review?** Wait for the user.

### 4. Review

- Run `/code-review` on the branch diff. Then `/security-review`.
- **Check unit-level coverage.** Any unit with real logic that's only covered
  transitively (through a higher-level test) needs its own direct test — treat that as a
  must-fix finding. `vitest` coverage (v8) is the signal; judgment decides, not a
  threshold. Trivial passthroughs are exempt.
- **Remediation loop (max 2 cycles):** if either surfaces must-fix findings, fix them,
  re-run the gates, and re-run the failed review. After 2 cycles still failing, stop and
  escalate to the user with the specifics — do not loop forever.

### 5. 🛑 Gate 2 — ship review

Present the `/code-review` and `/security-review` results (and any remediation). Ask:
**open the PR?** If the user requests changes, go back to step 4. Wait for approval.

### 6. Ship

- **Changeset.** If **Change type** is not `none`, write `.changeset/<slug>.md`:
  ```markdown
  ---
  "@pithy-sh/<pkg>": <patch|minor|major>
  ---

  <the issue's Release note, verbatim, brand voice>
  ```
  If Change type is `none`, skip — no changeset. (Changesets tooling may not be installed
  yet; the file is still the correct artifact and is consumed once it lands.)
- **Commit.** Conventional Commits, scoped, brand voice, with the issue number:
  ```
  feat(core): add SQLite codecs

  <short body if useful>

  #<N>
  ```
- Push the branch. Open the PR:
  ```bash
  gh pr create --base main --head feature/<N>-<slug> \
    --title "<conventional title>" --body "Closes #<N>

  <one-paragraph summary>"
  ```
  `Closes #<N>` auto-closes the issue on merge.
- Move Stage → `In review`. Give the user the PR link.

### 7. Done

When the PR merges, move Stage → `Done`. Merging is the user's call — handle the
transition on a later `/ship` run, or when asked. Do not auto-merge unless told to.

## Isolation: branch now, worktree later

`/ship` uses a plain feature branch today. The full worktree + ephemeral-CF + per-feature
port lifecycle described in `CLAUDE.md` is **the product Pithy is building** (`pithy
feature`, the port allocator, generated `.dev.vars`) — it does not exist yet. Once that
capability ships, `/ship` adopts it. Until then, `--worktree` may create a native git
worktree for isolation; if so, remove it the safe way — `rm <worktree>/.git && git
worktree prune`, never `rm -rf` or `git worktree remove` (inotify storms on Linux).

## Non-interactively (agents / CI)

Works headless: `/ship #N` with no person to gate proceeds through both gates
automatically only when explicitly told to run unattended; otherwise it stops and reports
at each gate. Prefer `--format json` / GraphQL for every board read. Never fabricate a
passing gate — if `typecheck`/`biome`/`vitest` fail, stop and report.

## Guardrails

- Requires `gh` with the `project` scope. On a missing-scope error, tell the user to run
  `gh auth refresh -s project`.
- Never move past a 🛑 gate without the user's approval.
- Never claim a gate passed without running it and seeing the output
  (`superpowers:verification-before-completion`).
- While solo (see **Current mode**), commit to `main` directly — that's the user's call.
  In collaboration mode, commit only on the feature branch, never to `main`. Never
  `--no-verify`.
- One issue per `/ship`. Keep the change scoped to the issue.
