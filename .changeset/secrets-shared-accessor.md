---
"@pithy-sh/secrets": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/turnstile": patch
---

Secrets are now resolved once per worker invocation and shared across all capabilities, cutting redundant Secrets Store round-trips.
