---
"@pithy-sh/cli": patch
---

A `.dev.secrets.jsonc` that will not parse is its own diagnosis, and doctor says nothing else.

`pithy doctor` already withheld `missing` and `undeclared` on an unparseable file: both are decided against what the file states, and a file that will not parse states nothing. `misplaced` was not withheld, and it is decided the same way — by comparing each `.dev.vars` copy with the envelope the file holds. With no envelope to compare, every copy fell through to `unmoved`, and the report told the adopter to go move pithy's own injected lines.

That is the one action that breaks dev before #153 lands, recommended by the same run that had just said the file was broken. Now a project with an unreadable file hears exactly one sentence about it.
