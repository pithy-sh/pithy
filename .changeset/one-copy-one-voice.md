---
"@pithy-sh/cli": patch
---

The seeder and `pithy add` tell pithy's own injected copy from an adopter's `.dev.vars` line.

Once a secret had been seeded, the transitional copy left in `.dev.vars` read as the pre-#149 migration
case — so deleting the secret from `.dev.secrets.jsonc` suppressed it permanently: never minted again,
never seeded, never reported. An encoded envelope is this tool's writing; a bare string is the adopter's.

Also: a lookup keyed by a secret name is prototype-free at every boundary, and a refusal both halves of
`pithy add` reach is printed once.
