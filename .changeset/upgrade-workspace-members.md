---
"@pithy-sh/cli": patch
---

`pithy upgrade --packages` moves `@pithy-sh/*` ranges in every workspace member, not just the root and `apps/*`, so one install holds one version of each kit package.
