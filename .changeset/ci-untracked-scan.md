---
"@pithy-sh/cli": patch
---

The binary and invisible-character gates see a file before it is committed.

Both scanned `git ls-files`, which reads the index — so a file that exists and has never been `git add`ed was invisible to them. The pre-commit hook runs Biome on staged files rather than the suite, so the first scan that could see a new file was the one *after* the commit that tracked it. That is how a NUL byte reached `main` once already: not because the rule was wrong, but because the set it was quantified over did not yet hold the file.

The listing now adds `--others --exclude-standard`. Everything `.gitignore` covers stays out, so this repository's own scaffolded fixtures are not findings, and what is left is a file somebody wrote and means to commit — which is the file the rule is about.
