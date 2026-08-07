---
"@pithy-sh/cli": patch
---

The dev-secrets gitignore check answers what git would answer.

An indented pattern read as covering the file — git keeps a pattern's leading whitespace and only strips
trailing. And a `.dev.secrets.jsonc` git already tracks is not covered by any pattern at all, so a mint
landed in a file the next commit carries. Both are refusals now, each naming the one thing to do.
