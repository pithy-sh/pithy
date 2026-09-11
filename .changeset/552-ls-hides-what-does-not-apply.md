---
"@pithy-sh/cli": minor
---

`pithy secrets ls` lists the secrets your configuration actually uses.

A capability declares its secrets whether or not you use them, and the ones nothing will ever read are no longer listed — a project running Google and GitHub has two OAuth credentials to think about, not four. It marked them *not applicable* before, which was still a line on a checklist and still re-raised a settled question on every run. The count of what was left out is always shown, and `pithy secrets ls --all` brings them back with the reason each one does not apply.
