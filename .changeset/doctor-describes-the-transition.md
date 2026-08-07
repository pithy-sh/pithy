---
"@pithy-sh/cli": patch
---

`pithy doctor` describes the dev-secrets transition instead of arguing with it.

It named every `d1` secret in `.dev.vars` and said "Delete that line" — including the copies pithy
writes itself on every `pithy dev`, and deleting one is what breaks dev until #153. The three cases are
now told apart by comparing the copy with what the seeder would write.
