# Contributing to Pithy

How we work. GitHub is the source of truth — issues hold the specs, and the **Pithy** Projects board tracks where each idea sits. Two skills drive it: `/refine` shapes ideas into `Ready` issues; `/ship` builds and ships them.

## Capturing and refining work

Use `/refine`. It interviews you one question at a time, writes a structured GitHub issue, and moves it across the board.

| Command | Does |
|---------|------|
| `/refine` | Browse the board. Pick an idea to refine, or capture a new one. |
| `/refine #N` | Refine issue `N`. Re-run anytime to continue. |

The skill owns the mechanics — issue template, board ops, the lot. See [`.claude/skills/refine/SKILL.md`](.claude/skills/refine/SKILL.md).

## Building work

Use `/ship`. It takes a `Ready` issue and carries it to a merged PR — TDD implementation, the real gates (`typecheck` / `biome` / `vitest`), `/code-review` and `/security-review`, a PR that closes the issue, and a Changesets release note. It stops at two gates for your approval.

| Command | Does |
|---------|------|
| `/ship #N` | Build issue `N`. |
| `/ship` | Build the lowest-numbered `Ready` issue whose dependencies are `Done`. |

Mechanics live in [`.claude/skills/ship/SKILL.md`](.claude/skills/ship/SKILL.md).

## The board

The [Pithy board](https://github.com/orgs/pithy-sh/projects/1) tracks each issue's **Stage** across its life:

`Inbox → Refining → Ready` (owned by `/refine`) `→ Building → In review → Done` (owned by `/ship`).

## Setup

`gh` needs the Projects scope (read+write), one time:

```bash
gh auth refresh -s project
```

## Voice

Everything user-facing — issues, comments, commits, board copy — follows [`docs/BRAND.md`](docs/BRAND.md). Short sentences. Deliberate periods. No fluff.
