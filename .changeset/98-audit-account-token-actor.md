---
"@pithy-sh/audit": patch
"@pithy-sh/cloudflare": patch
---

CLI audit events now record the account-owned Cloudflare token that performed the action, instead of attributing it to `system`. Actor resolution reads the account-scoped token endpoints, which is where an account-owned token is valid — the user-scoped ones reject it. A token that cannot read its own name is attributed by id rather than lost.

Fixes the `d1:write` permission mapping, which named a Cloudflare permission group that does not exist. `pithy token mint ci-system` now works.
