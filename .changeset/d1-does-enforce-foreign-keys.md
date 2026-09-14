---
"@pithy-sh/core": patch
"@pithy-sh/auth": patch
"@pithy-sh/testers": patch
"@pithy-sh/organization": patch
---

Three migrations said D1 does not enforce foreign keys. It does.

`PRAGMA foreign_keys` is on, a cascade fires, and an orphan insert is refused with `FOREIGN KEY constraint failed` — measured against a real binding in two separately configured pools, and now pinned by a test in `@pithy-sh/core` that checks both directions.

The convention those docblocks describe is unchanged and still right: no foreign key crosses a capability boundary, because a constraint from one capability's table to another's binds two release cadences together and breaks the day either moves to its own database. What changes is the reason given for it. A false reason is worse than none, because it ends the conversation — and it was ending it on the platform rather than on the boundary, which is where the real trade is.

Nothing about any schema moves. Within a single capability's own tables a foreign key is available and is still not used; that is worth revisiting per table rather than as a rule.
