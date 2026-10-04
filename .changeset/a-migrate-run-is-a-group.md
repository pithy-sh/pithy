---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
---

Every `pithy migrate` run now belongs to a group — named with `--group`, or stamped with the time it ran — and `--rollback --group <value>` reverses exactly that group rather than one migration at a time. **`pithy migrate --rollback` without a group no longer reverses anything**: it names the group on top and the command that would reverse it.
