---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
"@pithy-sh/secrets": patch
"@pithy-sh/email": patch
---

`pithy token mint` creates scoped, least-privilege, account-owned Cloudflare API tokens for each job and stores them where you point it — no hand-crafting tokens in the dashboard. One `ci-system` credential covers your CI pipeline and grows as capabilities declare what they need; worker-consumer tokens (like the secrets manager's) land in the CF Secrets Store. Mint, list, rotate, and revoke, all non-interactive and `--json`.
