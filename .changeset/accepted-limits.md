---
"@pithy-sh/cli": patch
---

The filesystem races Node cannot close are written down, so the next reader finds a decision rather than an oversight.

`docs/ACCEPTED-LIMITS.md` records six of them: the `lstat` → `readlink` window in `resolveWritePath`, the inode check → `rename` window in `ensureUnswapped`, a pre-positioned file we own reaching `adoptableModeOf`, a bind mount that resolves inside the project and carries `removeScaffoldPath` out of it, Windows having no uid to compare, and the source-text half of the tripwires. Each names the function rather than a line, because a line number in a document is wrong by the next commit.

It states the threat model that decides how much they matter — every one needs an attacker who can already write to the project directory, and that attacker already has code execution through `postinstall`, a git hook, or `pithy.config.ts`. The bar these fail is relevance, not severity.

Two blockers were re-checked rather than repeated. Biome does ship `style/noRestrictedImports` and per-path `overrides`, so the tripwires stay a test because the rule is a conjunction Biome cannot express, not because the feature is missing. And `typescript@7.0.2` ships `unstable/ast` and `unstable/sync` — what it has no equivalent of is a string-to-AST parser, which is the thing an AST rule would need.

It also lists what was **not** accepted, with the issue behind each, so the record cannot be read as a shrug.
