---
"@pithy-sh/secrets": minor
---

`@pithy-sh/secrets`: every secret resolves through the one `secretsStore` reader, with the registry entry's `backend` the single place storage is decided. Local dev resolves every secret from `.dev.vars`; a deployed worker (identified by its `ENVIRONMENT` var) routes strictly by backend, so a `d1` secret is always read from the encrypted store and a stray plaintext binding can never shadow it. Deployed workers that read secrets must carry the `ENVIRONMENT` var (provisioning stamps it).
