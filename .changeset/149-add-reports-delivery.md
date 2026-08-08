---
"@pithy-sh/cli": patch
---

`pithy add` says which Worker its minted value did not reach.

`writeDevVars` grew `shadowed` and `undelivered` so a run stops reporting a delivery that did not
happen. Both of `pithy add`'s direct writes then took `.refused` off the result and dropped the rest,
so the defect survived at the caller: `pithy add secrets` printed "Minted a dev master key" while the
Worker answered `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS`.

One renderer now turns a write's result into lines, shared by `pithy add`, `pithy seed` and
`pithy dev`. A caller gets every list by taking the only thing there is to take.
