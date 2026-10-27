---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/support": minor
---

`pithy backup` dumps every D1 in an environment, skipping FTS5 indexes it can rebuild, in files that restore, and `pithy restore` brings them back into an empty database. Support search now uses FTS5 by default: run `pithy support provision` after upgrading.
