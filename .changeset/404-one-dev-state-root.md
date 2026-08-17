---
"@pithy-sh/cli": patch
---

One statement for the project's local dev state root.

`dev/orchestrator.ts` composed `join(projectDir, ".wrangler", "state")` itself, making
three independent derivations of one directory. It reads `localDevStateRoot` now, and
the scaffold gate holds the template's relative path against that function rather than
against a deeper path two `dirname`s away.
