---
"@pithy-sh/cli": patch
---

A config Pithy writes is a config Biome would print.

`pithy ui sync --worker board` in `pithy-sh/dashboard` did its job — it found the missing `/control-plane` in `run_worker_first` and corrected it — and then failed `biome check` in the pre-commit hook the CLI itself scaffolds, over four hunks of `"compatibility_flags": [\n "nodejs_compat"\n]` where Biome wants one line. The same run turned a two-line change into 78 insertions, which leaves the real edit somewhere inside a reformat nobody can review.

Every JSONC document the CLI writes now goes through one printer, `project/jsonc.ts`, holding two rules that together are Biome's `expand: "auto"` for JSON. **An array is one line when it fits and one element per line when it does not** — the width decides, so there is nothing to preserve. **An object keeps the shape it already had**, read from the bytes about to be replaced, because both shapes pass Biome and only one of them leaves the diff alone. A span holding a comment is never collapsed. `pithy ui add` went from a 15-line `wrangler.jsonc` diff to a 3-line one, and a `sync` that adds one path is now a one-line diff with the adopter's own expansions and notes untouched.

The starter's `biome.jsonc` stops exempting `wrangler.jsonc` and `pithy.worker.jsonc` from the formatter. Exempting the two files Pithy touches most was the workaround, not the fix, and it left every adopter with two files nothing formats.

The gate runs the adopter's toolchain rather than a literal: the scaffolded Biome config, over the scaffolded `wrangler.jsonc` and `pithy.worker.jsonc`, after the real wiring functions have edited them. It failed on all four counts before the printer landed.
