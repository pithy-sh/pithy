---
name: refine
description: Use when capturing, refining, or iterating on a product idea or GitHub issue for Pithy. Interviews the user one question at a time, structures the issue body, and moves it across the Pithy Projects board (Inbox → Ready) via `gh`. Invoke for "/refine", "/refine #N", turning a rough idea into a ready, well-specified issue, or grooming the backlog. GitHub Issues + Projects v2 are the single source of truth.
---

# refine

Turn ideas into ready, well-specified GitHub issues — and iterate on them over time. GitHub Issues are the source of truth. The **Pithy** Projects board tracks where each idea sits in its life. You drive both through `gh`.

This skill owns the front of the work pipeline: **Inbox → Ready**. Everything past `Ready` belongs to `/ship`.

## Voice

Every word you write into an issue, comment, or board is user-facing. `docs/BRAND.md` is binding. Short sentences. Deliberate periods. No fluff. No emoji. No "successfully created issue #12 in 1.2s." `Done.` Write the way Pithy is named.

## Fixed facts

- **Repo:** `pithy-sh/pithy`
- **Board:** Projects v2, org `pithy-sh`, title **Pithy** (currently project number `1`).
- **Status field:** a single-select field named **Status** with options `Inbox`, `Ready`, `In Progress`, `Done`. `/refine` drives only the first two (`Inbox → Ready`); `/ship` owns the rest.

Never hardcode option IDs. Resolve them at runtime — option IDs change whenever a field's options are edited. Project id and field id are stable; option ids are not.

## Stages

| Status | Meaning |
|--------|---------|
| `Inbox` | Captured. Not yet refined. A title and a sentence is enough to land here. |
| `Ready` | Problem and acceptance criteria agreed. Ready to be picked up by the build pipeline. |

An item moves `Inbox → Ready` only once the acceptance criteria are written and the user agrees it's ready. Don't move it to `Ready` on your own judgment — confirm first.

## Issue body template

Every refined issue's body follows this shape. Keep headings exactly; scale each section to what's known. An `Inbox` idea may have only **Problem** filled. A `Ready` issue has all of it: a real acceptance checklist, a release note, and a change type.

```markdown
## Problem

What hurts, and why it matters.

## Proposal

The shape of the fix. Not an implementation plan — the intended behavior.

## Scope

**In:** what this issue covers.
**Out:** what it deliberately does not.

## Acceptance criteria

- [ ] Observable, checkable outcomes. Each one true/false, no maybes.

## Release note

One user-facing sentence in brand voice, for the changelog. `N/A` if this ships no note (chores, internal refactors, docs). This sentence becomes the changeset summary when the work ships — write it the way it should read in the release.

## Change type

`major` · `minor` · `patch` · `none` — the semver bump. Aligns with the Conventional Commit type (`feat` → minor, `fix` → patch, breaking → major, chore/docs → none).

## Open questions

- Anything unresolved. Empty when nothing's open.
```

## How to run

### 1. Resolve target

- **`/refine #N`** → refine issue `N`. Read it first (below).
- **`/refine` with no number** → browse. List the board grouped by Status and offer to (a) pick an item to refine, or (b) capture a new idea. Show the user the list; let them choose.

### 2a. New idea

1. Ask, briefly, for the one-line problem if you don't have it. Don't over-interview at capture time — capturing should be cheap.
2. Create the issue with at least **Problem** filled:
   ```bash
   gh issue create --repo pithy-sh/pithy --title "<concise title>" --body-file <tmpfile>
   ```
   (Use `--body-file`, not `--body`, so markdown and newlines survive. Write the body to a temp file first.)
3. Add it to the board and set Status = `Inbox` (see **Board ops**).
4. Tell the user it's captured, with the issue number and URL. Offer to refine it now.

### 2b. Refine an existing issue

1. Read current state:
   ```bash
   gh issue view <N> --repo pithy-sh/pithy --json number,title,body,url,state,labels
   ```
   Also read its current Status from the board (**Board ops → read**).
2. **Interview the user one question at a time.** One question per message. Prefer concrete multiple-choice when you can. Work through the template sections that are thin or missing — Problem, Proposal, Scope, Acceptance criteria, Open questions. Stop when the issue is genuinely sharp, not when the template is merely full.
3. After each meaningful answer (or at the end), rewrite the issue body to the template:
   ```bash
   gh issue edit <N> --repo pithy-sh/pithy --body-file <tmpfile>
   ```
   Always edit the **whole** body from the template — don't append fragments.
4. Before `Ready`, draft the **Release note** (one brand-voiced sentence, or `N/A`) and set the **Change type** with the user. When acceptance criteria, release note, and change type are agreed, confirm and move Status to `Ready`. Don't promote to `Ready` unilaterally.

### 3. Iterate

`/refine #N` is re-runnable. Each run reads the current issue + Status and continues from there. That is the loop — refinement is never "done" in one pass.

## Board ops

All board writes need the resolved project id, Status field id, and the target option id.

**Resolve IDs** (run these, parse the JSON):

```bash
# Project number + node id (match .projects[] where .title == "Pithy")
gh project list --owner pithy-sh --format json

# Status field id + option ids (match .fields[] where .name == "Status"; each option is {id, name})
gh project field-list <projectNumber> --owner pithy-sh --format json
```

**Read the board** (item ids + each item's Status):

```bash
gh project item-list <projectNumber> --owner pithy-sh --format json
```

Each item exposes: `.content.number`, `.content.title`, `.content.url`, `.id` (the **item** id — distinct from the issue number), and `.status` (the Status option name, e.g. `"Inbox"`; note gh lowercases the field name into the JSON key). To find the board item for issue `N`, match `.content.number == N`.

**Add an issue to the board** (returns the new item `.id`):

```bash
gh project item-add <projectNumber> --owner pithy-sh --url <issueUrl> --format json
```

**Set an item's Status:**

```bash
gh project item-edit \
  --id <itemId> \
  --project-id <projectNodeId> \
  --field-id <statusFieldId> \
  --single-select-option-id <statusOptionId>
```

If an issue isn't on the board yet (e.g. created outside this skill), add it first, then set Status.

## Bootstrap (only if missing)

The board and Status field already exist. Only if `gh project list --owner pithy-sh` shows no **Pithy** project, recreate it — idempotently:

```bash
gh project create --owner pithy-sh --title "Pithy"
# The default Status field is created automatically with Todo/In Progress/Done.
# Update it to the correct options: Inbox, Ready, In Progress, Done.
```

## Driving non-interactively (agents / CI)

Humans and agents drive the same skill. When invoked without a person to interview (e.g. `/refine #N` from another skill, or a one-shot capture), do not block on questions: act on what's provided, write what you can to the template, and report what's still open in the **Open questions** section rather than asking. Prefer `--format json` on every `gh` read so output is parseable. Never invent acceptance criteria to force a `Ready` — leave it at `Inbox` and say what's missing.

## Guardrails

- Requires `gh` with the `project` scope (read+write Projects v2). If a board call fails with a missing-scope error, tell the user to run `gh auth refresh -s project`.
- Never move an item to `Ready` without the user's agreement.
- Never silently truncate or drop existing issue content when rewriting the body — fold it into the template.
- One question at a time. Always.
