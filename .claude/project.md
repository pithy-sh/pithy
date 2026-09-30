# Project card — `pithy-sh/pithy`

Read by the shared `/refine` and `/ship` skills in the workspace root (`../.claude/skills/`). **The process lives in the skill; the facts about this repo live here.** When a skill says "read the project card", this is the file.

## Identity

- **Repo:** `pithy-sh/pithy` — the kit. MIT, published to npm as `@pithy-sh/*`.
- **Board:** Projects v2, org `pithy-sh`, title **Pithy** — project **#1**, id `PVT_kwDOEV7hPs4BZ_c6`.
- **Status field id:** `PVTSSF_lADOEV7hPs4BZ_c6zhU6JTk` — options `Inbox · Ready · In Progress · Done`.
- **Voice:** `docs/BRAND.md` is binding.

## Issue sections beyond the shared template

- **Release note** — one brand-voiced sentence for the changelog, or `N/A` when this ships no note (chores, internal refactors, docs). This becomes the changeset summary verbatim.
- **Security** — `N/A`, or one sentence naming **what the exposure was** — what was wrong before this ships. Different from the release note, which says what changed. It becomes the `Security:` line in the changeset body, and it is what a customer decides on when asking whether to upgrade urgently.
- **Change type** — `major · minor · patch · none`. Aligns with the Conventional Commit type (`feat` → minor, `fix` → patch, breaking → major, chore/docs → none).

**Ask about Security explicitly — never infer it.** "Does this close something that was exposed?" The judgment is cheap now and unreliable to reconstruct at release time, which is the whole reason it is captured here. `N/A` is the common and correct answer; a security fix that ships unmarked is the failure this field exists to prevent.

## Shipping

**Changeset: yes.** If **Change type** is not `none`, write `.changeset/<slug>.md`:

```markdown
---
"@pithy-sh/<pkg>": <patch|minor|major>
---

<the issue's Release note, verbatim, brand voice>

Security: <the issue's Security sentence — omit this line entirely when it is N/A>
```

**The `Security:` line goes in the body, never the frontmatter.** `@changesets/parse` reads every frontmatter key as a package name, so a `security:` key there breaks `changeset version`. Omit the line when the field is `N/A`; never invent one, and never drop one the issue states. See `docs/RELEASING.md`.

## Isolation

`scripts/worktree.ts`, via `bun run worktree setup|teardown <N> <slug>`. It cuts `feature/<N>-<slug>` and a `.worktrees/<N>-<slug>` worktree off `origin/main`, installs deps, and links `.dev.vars` when one exists. Teardown drops the gitlink, prunes the registration, then removes the directory — **never** `git worktree remove`. It keeps the files when `.dev-state.json` says a `pithy dev` session may still be watching. Both are idempotent.

> `pithy feature create` is the product's own answer to this and is what the dashboard uses. The kit still ships `scripts/worktree.ts` and uses it here. If that changes, change it in this card, not in the skill.

## Gates

```bash
bun run typecheck
bunx biome check .
bun run test        # or: bun run --filter <pkg> test
```
