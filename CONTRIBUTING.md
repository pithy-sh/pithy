# Contributing to Pithy

How we work. GitHub is the source of truth — issues hold the specs, and the **Pithy**
Projects board tracks where each idea sits. You drive both through `/refine`.

## Capturing and refining work

Use `/refine`. It interviews you one question at a time, writes a structured GitHub
issue, and moves it across the board.

| Command | Does |
|---------|------|
| `/refine` | Browse the board. Pick an idea to refine, or capture a new one. |
| `/refine #N` | Refine issue `N`. Re-run anytime to continue. |

The skill owns the mechanics — issue template, board ops, the lot. See
[`.claude/skills/refine/SKILL.md`](.claude/skills/refine/SKILL.md).

## The board

The [Pithy board](https://github.com/orgs/pithy-sh/projects/1) tracks each issue's
**Stage**: `Inbox → Refining → Ready`. `Ready` issues get picked up by the build
pipeline — added as the toolset grows.

## Setup

`gh` needs the Projects scope (read+write), one time:

```bash
gh auth refresh -s project
```

## Voice

Everything user-facing — issues, comments, commits, board copy — follows
[`docs/BRAND.md`](docs/BRAND.md). Short sentences. Deliberate periods. No fluff.
