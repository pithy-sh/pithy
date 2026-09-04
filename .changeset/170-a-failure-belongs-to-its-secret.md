---
"@pithy-sh/secrets": patch
---

A secret that cannot be resolved fails its own read, not everyone else's.

`secretsStore` resolves the whole registry up front, and the shared accessor hands it the combined registry of every composed capability. So one declared-but-unset secret, anywhere, made the accessor unavailable to all of them: a route reading `auth-session-secret` failed with `secrets/not_found` on `auth-google-credentials` until all four OAuth pairs were seeded. None of them are needed unless that provider is enabled, and auth's registry says so in prose. Eager resolution turned every conditional secret into a boot requirement, and did it across a capability boundary neither capability's code mentions.

A secret that fails to resolve now holds its error, and the read of that secret raises it. Nothing is swallowed — a genuinely missing secret still fails loudly, still names itself, still at the first read of it. It just stops taking its neighbors down. A store nobody can reach is held the same way, against each `d1` secret by name, so a `cf-secrets-store` secret beside it still reads.

The named reads stay synchronous. Resolution is still eager and still one batch; only the failure moved.

Fixes #170.
