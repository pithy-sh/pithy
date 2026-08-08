---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
"@pithy-sh/secrets": patch
---

`pithy add` writes every option the capability requires.

`pithy add` renders one `key: default` per manifest option, and a manifest could only state a JSON scalar. `SecretsConfig.registry` is neither optional nor a scalar, so no manifest could declare it and `pithy add secrets` wrote `secrets({ rotationIntervalDays: 30 })` — a registration missing a required property. `bun run typecheck` on a freshly scaffolded project then failed `TS2741` before the adopter had touched a file, and secrets is the first capability most projects add, because auth, email and payments all read their credentials through it.

An option's manifest value may now be an empty object or an empty array, and `@pithy-sh/secrets` declares its `registry` as one. The contents stay the adopter's — `add` cannot invent a secret — but the key is present, the config compiles, and the comment above it says what belongs inside. `pithy upgrade` reports and writes the same option into a project that composed secrets before this. Neither `--set` nor the interactive prompt will touch such an option: both carry strings, and a registry is not a string.

`scaffoldGates.test.ts` now runs `pithy init` → `pithy add secrets` → `tsc -b` against a real scaffold, which is the sequence that was never run end to end.
