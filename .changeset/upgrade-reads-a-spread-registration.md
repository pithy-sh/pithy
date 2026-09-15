---
"@pithy-sh/cli": patch
---

`pithy upgrade` no longer overwrites an option a registration supplies as a shorthand or through a spread.

The key scanner recorded a key only when a colon followed it. `turnstile({ widgets })` and `turnstile({ ...base })` read as missing `widgets`, so `pithy upgrade` appended the manifest default after them. The later key wins, and a project's real sitekeys were replaced with blanks. `pithy doctor` reported the same drift and failed its exit.

A key now counts as present however it is written: `key: value`, a shorthand, a method or an accessor. A registration that spreads or computes keys might carry any option, so nothing is reported or written for it. `pithy add` asks the same question before refusing a required option, so a spread registration is not refused either.
