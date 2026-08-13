---
"@pithy-sh/cli": patch
---

Refuse a split global secret with a remedy that exists, and report what a half-finished fan-out wrote.

`mintDeclaredSecrets` finds a `global` secret in some environments and not others, and refuses rather than completing the split with a second value. That lockstep was right. Two things around it were not.

The refusal offered a repair no command can perform. It read *"give the others the same value with `pithy secrets create`"*, and for the secrets this creates nobody can: they are `d1`, 256 bits of `crypto.getRandomValues`, sealed under a master key that never leaves the manager Worker. There is no way to read the value back out of the environment that holds it, so an operator reaching for the first branch found no first step. It now names the one remedy that works — remove the secret everywhere with `pithy secrets rm`, then run again — and says plainly what that costs: a live signing key destroyed, and everything signed by it stops verifying.

The report was assembled after the delivery loop, so any throw inside it took the whole record with it. A fan-out that wrote staging and then lost prod left staging holding a brand-new signing key and told the operator nothing was created. The entry now enters the report on the first write that lands and grows one environment at a time, and whatever a run wrote rides out on the error that ended it — carried, never replacing it, so the failure an operator has to read is unchanged. `pithy secrets provision` prints what landed before the failure, in both the human output and `--json`, and still exits 1.

Fixes #324.
