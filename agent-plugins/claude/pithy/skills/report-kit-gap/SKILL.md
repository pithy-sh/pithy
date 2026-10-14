---
name: report-kit-gap
description: File something the Pithy kit cannot do against pithy-sh/pithy, without customer code or secrets, and mark the workaround. Use when a Pithy capability, command or route is missing, broken, or behaves differently from its docs.
argument-hint: "[what the kit cannot do]"
---

When the kit cannot do something this app needs, the fix belongs in the kit, not only in this project. Report it, then mark the workaround so it is found and removed when the fix ships.

## 1. Gather the facts

Run these, and keep their output:

```bash
pithy --version
pithy doctor --json
```

Note which Claude Code plugins are active in this session: `pithy`, and any add-on such as `pithy-games`.

## 2. Build a minimal repro

The smallest thing that shows it: a command and its output, or a few lines of config or route code written fresh for the report.

**Never include the customer's code, and never a secret.** Not their routes, schemas, data or business logic. Not a token, a key, a `.dev.vars` value, an account id or a domain. Rewrite the repro from scratch with neutral names. If the gap cannot be shown without their code, describe it in words instead.

## 3. Search before filing

```bash
gh search issues "<the key words>" --repo pithy-sh/pithy --state open
```

If an open issue already describes it, do not file a duplicate. Draft a comment for that issue with the new facts and the repro, show it to the user, and post it only on their explicit yes:

```bash
gh issue comment <number> --repo pithy-sh/pithy --body-file <file>
```

## 4. Draft the issue on the right form

Something documented that does not work is a **bug**: the `bug.yml` form. Something the kit should do and does not is a **feature**: the `feature.yml` form. Fill its fields in the body, under the form's own labels.

- Bug: **Version** (`pithy --version`, and the `@pithy-sh/*` package versions involved), **OS and shell**, **What you ran**, **What you expected**, **What happened**.
- Feature: **The problem**, **What you propose**, **What you do today instead**.

Under both, add the `pithy doctor --json` output in a collapsed block, with any account id, domain or path that names the customer removed, and a line naming the active plugins.

End the body with this line, exactly. The repository's intake workflow reads it and applies `from: pithy-plugin` and `needs-triage`, because an issue filed this way skips the form that would have applied them, and GitHub drops labels set by anyone without triage access:

```text
Filed with the pithy plugin for Claude Code.
```

## 5. File only on an explicit yes

Show the user the title and the body, and ask. File only if they say yes:

```bash
gh issue create --repo pithy-sh/pithy --title "<title>" --body-file <file>
```

If `gh` is not installed or not signed in, do not install it or sign it in. Hand the user a prefilled URL on the form instead. A form fills each field from the query parameter named by its id, so every value goes in its own parameter, URL-encoded:

```text
https://github.com/pithy-sh/pithy/issues/new?template=bug.yml&title=<title>&version=<version>&environment=<os and shell>&command=<what you ran>&expected=<expected>&actual=<what happened>
https://github.com/pithy-sh/pithy/issues/new?template=feature.yml&title=<title>&problem=<problem>&proposal=<proposal>&alternatives=<what you do today>
```

End the last field, `actual` or `alternatives`, with the marker line, so the intake workflow labels it the same way. The form applies `needs-triage` itself.

## 6. Mark the workaround

Wherever this project works around the gap, leave a comment at the workaround naming the issue:

```ts
// Works around pithy-sh/pithy#<number>. Remove when it ships.
```

Report the issue's link, or the comment's, in one line.
