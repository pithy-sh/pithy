---
"@pithy-sh/cli": patch
---

`pithy doctor` and `pithy adopt` stop reading a failed config as a project that declares nothing.

#199 fixed the producer: `resolveDevSecretsTargets` answers `{ targets, unresolvable }`, so a `pithy.config.ts` that will not import is a field rather than an absence. Four consumers still took the lossy list — the three `doctor` checks and `adopt` — and each read "this Worker could not be asked" as "this Worker declares nothing". Registries merge project-wide, so a healthy sibling does not rescue the answer: its registry is real, and it is not the project's.

**`doctor` was silent in the one state it was written for.** `checkDevSecrets` returned `null` for an empty target list, over a comment reading "`null` means no Worker composes `secrets`" — which was also every Worker's config failing to import. The whole `Dev secrets:` block disappeared. Same shape as #166: a line that vanishes in the report that needed it. It reports now, first in the block, because it explains every line under it:

```
Dev secrets:
  replay-board's pithy.config.ts would not import, so nothing here knows what it declares. …
  MYSTERY_KEY is in .dev.vars, and nothing here can say what reads it while replay-board will not import. Fix that first.
```

It reports and does not refuse: the rest of the report — Cloudflare reachability, project health, the secrets paths — still prints. A diagnostic that dies on what it is diagnosing is worse than one that names it.

**`adopt` was worse than unhelpful.** It decides where each value belongs by asking the registry, and its verdicts are what an adopter acts on — including which lines are now safe to delete. It never deletes anything itself, which is exactly why that matters: the loss arrives one step later, by hand, on this command's advice. A registry secret read as a key nothing composes came back `nothing reads it`. It now refuses that value by name, keeps it out of the safe-to-remove list, and fails the exit — while moving everything it still has positive evidence for, since a Cloudflare credential needs no registry to place.

The rule under both is one line: **`unread` is a negative claim, and a registry nobody could read is exactly what might have declared it.** `credential`, `secret` and `binding` survive a partial resolution because each rests on positive evidence — a fixed credential list, a registry that did declare the name, a composition that does want it. So a fifth root-key state, `unclassified`, is what is left when the only remaining answer would have been an inference from a file nobody could open. `devVarsLocal` withholds `devOnly` and `checkDevSecrets` withholds `undeclared` on the same rule, both of them negative claims.

`--json` carries `unresolvable` on `devSecrets` and `devVars`, each entry naming the Worker, its directory and the reason. A `devSecrets` object carrying one is how a script tells "nothing loaded" from the `null` that now means only what it says: this project composes no secrets.
