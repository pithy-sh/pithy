---
"@pithy-sh/cli": patch
---

A `--json` key means one thing across the CLI, every payload names the command that wrote it, and a gate keeps it that way.

`pithy upgrade --json` dropped `deployedAs` on a real run. `ReconcilePlan` carried it, `ReconcileApplied` did not, and both come back in the same `workers` array with `dryRun` saying which — so a consumer that read the deployed script name worked under `--dry-run` and read `undefined` on the run that actually wrote something. The applied entry carries it now.

`pithy alias --json` lost its `action` key on the unknown-shell path — the one path where nothing was written to any file, and so the one a caller most needs to classify. Every alias payload leads with `command` and `action` now; `alias` was also the only command in the CLI whose payload never named itself.

The durable part is the gate. Every documented payload names its `command`, and every top-level key more than one command emits is enrolled in a shared vocabulary asserted equal to the pages in both directions. A scan cannot read meaning, and the wording of two pages that agree is free to differ, so the gate does not pretend to compare sentences — it makes a shared name impossible to introduce silently. A key a second command starts using fails until someone writes it down beside the command that already had it, which is the comparison that was never being made. Proven by planting a collision, rather than asserted.

`pithy doctor --json` is the one payload still not naming its command, listed and asserted rather than excused, so closing it fails the gate until the list shrinks with it.
