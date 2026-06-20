---
"@pithy-sh/auth": minor
---

New package: `@pithy-sh/auth` — passwordless sign-in (magic link, email OTP, Google, Apple) for mobile and web. Short-lived JWT access tokens verified locally against published JWKS, rotated refresh sessions, CSRF-protected web cookie sessions, and a per-device session registry. Fills core's `bearer`/`session` strategies, auto-gates its send routes with turnstile when composed, runs two-tier rate limiting, and emits `auth/*` audit events.
