---
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
"@pithy-sh/email": minor
"@pithy-sh/secrets": minor
---

A secret that declares how often it rotates now rotates on that schedule, and retires its old version only once nothing still needs it. Declare `rotateEveryDays` and an `overlap` on a registry entry, and each environment's secrets manager rotates it from its nightly cron, records the run, and retires the previous version after the overlap. `auth({ sessionSecretRotateEveryDays })` turns it on for the session secret: a session or a bearer token signed before the rotation is re-signed on its next request, and the JWKS keys are moved under the new version before the old one goes. `auth()` refuses the period beside `twoFactor()`, whose secrets nothing moves yet. The link-signing key keeps its previous version for as long as a link lives. A failed rotation shows in `pithy doctor` and the secrets status read.
