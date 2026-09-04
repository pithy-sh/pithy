---
"@pithy-sh/secrets": minor
"@pithy-sh/cli": minor
---

A global secret has one value in every environment, or provisioning stops.

`mintDeclaredSecrets` dispatched `ensure` — write when absent, skip silently when present — once per environment. That is a per-environment answer to a cross-environment question, and it broke the property it was written for. A run that wrote staging and lost prod, re-run, minted a **second** value, found staging present, skipped it, and wrote the second value into prod. Two environments, two values, no error, and every link signed by one refused by the other. `global` exists so a link signed in staging verifies wherever the recipient's click lands; that is precisely what it stopped doing.

The decision moves in front of the writes. `runWriteSecret` takes `probe` instead of `ensure` — a store read that writes nothing and answers `present` or `absent`, in the manager, because a `d1` value is sealed under a master key the CLI never holds. `SecretProbe` is the CLI seam for it, separate from `SecretDispatcher` because a read and a write are opposite contracts and folding one into the other is how a check becomes the write it was meant to gate. Every target is asked, then one decision is taken: all present, nothing happens; all absent, one value for a `global` secret and a fresh one per environment otherwise; **split, and the run fails**, naming the secret and both sides. Repairing a half-written signing key is a choice with consequences that differ by secret, so the tool does not make it.

The writes are `create`, which raises on a name already there. Probing narrows the race between two concurrent runs; `create` closes it — the loser is refused at its first write instead of fanning its own value into the environments the winner has not reached. `ensure` is gone: a mode whose whole behavior is to be quiet had no safe caller.

`mintSecretValue` is now called only for environments known to be empty. It used to run for every declared secret on every run, before absence could be known, so a nightly `pithy secrets provision` generated fresh 256-bit key material for already-provisioned secrets and deposited it, unused, in retained Workflow instance params. On a provisioned project nothing is generated at all.

The write Workflow returns what it did. `pithy secrets provision` says `created in staging, prod` or `already in staging, prod` rather than the unfalsifiable `ready`, and the CLI decodes that output through Zod — an answer it cannot read stops the run, because "unreadable" defaulting to "absent" is the one wrong answer that mints over a live key.

`pithy provision --env` and `--feature` still create no `d1` secret: they run before the managers are necessarily deployed, and only a manager can answer for one. They now say so. A run names the secrets it is leaving absent and the command that makes them, from the same predicate the creator uses, so a capability that declares an arbitrary secret tomorrow is named without anyone maintaining a list.
