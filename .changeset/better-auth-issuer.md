---
"@pithy-sh/auth": patch
"@pithy-sh/organization": patch
---

Sign-in works again on the Better Auth a fresh install resolves, and the kit now requires Better Auth 1.7.11, past a critical account-takeover fix. A new migration relaxes the account `issuer` column that Better Auth 1.7.3 stopped writing. Magic Links and OAuth sign-ins started before the upgrade must be restarted. A social sign-in that fails to attach the provider to an existing account now redirects with `provider_sign_in_refused`, like the other refusals the user table decides.

Security: The kit's `better-auth` range admitted versions with GHSA-965c-763c-88jm, a critical flaw that let anyone who knew a user's email sign in as them through Magic Link on any deployment with a social provider configured. Separately, `unable_to_link_account` reached the browser on the social callback only when an account already existed at the address, so a failed account write answered the same question the collapsed codes do. It is collapsed now.
