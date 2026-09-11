---
"@pithy-sh/cli": minor
---

Only a composition decides whether a secret applies, and a config that will not load for a declared environment is a fault `pithy doctor` now raises.

Whether a secret applies is a property of the composition; environments come into it only because a `pithy.config.ts` may gate a provider on `compositionEnvironment()`. An environment whose config *throws* is not a composition — no capabilities, no registry, nothing that could need a value — so it now contributes nothing to the answer instead of contributing *everything applies*. Under "in reach anywhere wins" that non-vote beat every environment that really composed, so one half-configured `prod` switched off the whole of #541, silently, on every run. `pithy secrets ls` says which environments its marks were decided from, and doctor reports the config itself under a new `Environment configs:` block — naming the environment, the config's own action, and that every command composing it fails the same way. That one fails the exit.

A project whose config throws for a declared environment exits non-zero from `pithy doctor` where it exited zero before, so a CI gate that calls it will start failing — on a fault that was already there and already breaking every command that composes that environment.
