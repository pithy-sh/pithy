---
"@pithy-sh/cli": patch
---

Two things a new project met on its first run, and one gate each.

**A scaffolded `biome.jsonc` no longer reports a schema mismatch.** The starter declared `@biomejs/biome` at `^2.5.8` beside a `$schema` naming `2.5.8`. The caret floats and a URL cannot, so the first `biome check` an adopter ever ran resolved a newer patch against an older schema and said so. Nothing failed — it is `info` severity — which is the reason to fix it rather than the reason not to: the first diagnostic a project shows its owner should not be one they are taught to skip. Biome is now pinned exactly, in the starter and in this repository, which is what a linter wants anyway.

**`docs/commands/payments.md` named a command that does not exist.** It said `pithy secrets set payments-provider-credentials`, twice, and the spelling is `create`. That line is the documented path for every externally issued credential in the product — Apple's `.p8`, Google's service-account key, Stripe's pair, Lemon Squeezy's and Paddle's keys — so a reader following it exactly failed on the one step nothing can do for them.

Both are now checked. A Biome config's `$schema` must name the version the manifest beside it pins, and every `pithy <command> <subcommand>` written in a code span anywhere in `docs/` must be a command the CLI actually has.
