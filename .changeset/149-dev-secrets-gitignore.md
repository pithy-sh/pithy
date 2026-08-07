---
"@pithy-sh/cli": patch
---

A dev secret is never written into a file the project does not ignore.

The `.dev.secrets.jsonc` ignore lines ship in the starter template, applied at `pithy init` — so they exist in projects scaffolded after that change and in no others. Every project older than it, `pithy-sh/dashboard` included, got a live minted signing secret written into a file git would commit.

`writeDevSecrets` now verifies the ignore **before** the bytes, every time: it is the one funnel every dev secret passes through, so the guarantee lives there rather than at each call site. A `.gitignore` that does not cover the file gains the lines; one that cannot be read or written means **nothing is written at all** and the command says exactly what to add. Minting first and hoping is not a guarantee.

`.dev.secrets.jsonc.tmp` is covered too, in the guard and in the template. `.dev.vars.*` covers `.dev.vars`'s temp sibling and nothing covered this one — and a temp file surviving a SIGINT holds the full plaintext.
