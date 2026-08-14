---
"@pithy-sh/core": patch
---

A manifest from a Worker deployed before the health fields parses again.

`healthKeys` and `health` arrived required, so every Worker deployed before them failed validation — at
the object level, which cost a client the whole manifest rather than the part it did not know about. The
control-plane manifest carries no schema version on purpose, so tolerating absence is the only way a new
field ships without breaking what is already running. Both default now, and an absent declaration means
nothing declared, which is what it always meant.
