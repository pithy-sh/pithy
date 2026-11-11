---
"@pithy-sh/cli": patch
---

`pithy doctor` treats a checkout nothing has set up as not set up rather than failing, so CI runs it without `pithy setup`.
