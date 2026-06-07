# Workflow

GitHub is the source of truth. Issues hold the specs. The **Pithy** Projects board
tracks where each idea sits. We drive both through `gh` — no separate tracker, no docs
that drift out of sync.

## The board

- **Pithy** — Projects v2, org `pithy-sh` ([project #1](https://github.com/orgs/pithy-sh/projects/1)).
- Lifecycle lives in a single-select field named **Stage**:

  | Stage | Meaning |
  |-------|---------|
  | `Inbox` | Captured. Not yet refined. |
  | `Refining` | Being fleshed out now. |
  | `Ready` | Problem + acceptance criteria agreed. Ready to build. |

  (GitHub's built-in `Status` field is reserved and unused. **Stage** is ours.)

## Refining ideas — `/refine`

The `/refine` skill captures and sharpens ideas. It interviews you one question at a
time, writes a structured issue body, and moves the item across the board.

| Command | Does |
|---------|------|
| `/refine` | Browse the board. Pick an item to refine, or capture a new idea. |
| `/refine #N` | Refine issue `N`. Re-run anytime to continue — refinement is a loop. |

Every refined issue follows one body shape: **Problem · Proposal · Scope · Acceptance
criteria · Open questions**. An `Inbox` idea may have only the problem; a `Ready` issue
has a real acceptance checklist.

## Setup

`gh` needs the Projects scope (read+write):

```bash
gh auth refresh -s project
```

That's the only one-time step. The board and **Stage** field already exist; `/refine`
recreates them idempotently if they're ever missing.

## Voice

Issues, comments, and board copy follow `docs/BRAND.md`. Short sentences. Deliberate
periods. No fluff.
