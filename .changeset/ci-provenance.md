---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

Released from CI, with provenance.

Every package's first release was cut from a laptop, and a laptop has no OIDC identity to attest with — so `0.1.0` carries no provenance. This one is built and published by the release workflow over npm trusted publishing, so `npm audit signatures` can verify each tarball came from this repository, from `main`, from the workflow that claims it.

No code changed. The difference is what an adopter can prove about what they installed.
