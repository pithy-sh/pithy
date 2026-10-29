---
"@pithy-sh/auth": patch
---

The sign-in gate reads the Turnstile token where `turnstile({ token })` says. A token sent in a configured header no longer refuses every sign-in.
