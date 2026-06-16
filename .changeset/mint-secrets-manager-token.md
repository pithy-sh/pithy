---
"@pithy-sh/cloudflare": minor
"@pithy-sh/secrets": minor
"@pithy-sh/cli": minor
---

`pithy secrets provision` now mints the secrets manager's own scoped Cloudflare API token and writes it straight into the Secrets Store. No more hand-created `.dev.vars` token. `@pithy-sh/cloudflare` gains a reusable account-token client — mint, roll, and delete account-owned tokens from a set of permissions — and the manager token is its first use. The bootstrap token needs `Account API Tokens Write`; a token that lacks it fails fast, with the reason.
