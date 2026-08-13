---
"@pithy-sh/core": patch
"@pithy-sh/payments": patch
"@pithy-sh/storage": patch
"@pithy-sh/media": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/secrets": patch
---

A key is not a field, and four capabilities could not go red.

**Degrading a record key merges it.** `needs` is keyed by issuer, and #324 gave the key the field's rule — `SecretIssuer.catch("other")`. On a field that rewrite is a rename and costs nothing; on a key it is a silent merge. Keyed that way, `{ vercel: ["deployments:write"], netlify: ["sites:write"] }` parsed to `{ other: ["sites:write"] }`: vercel's requirement gone, the parse successful, nothing anywhere reporting it. Requirements lost without a word are worse than a manifest that refuses to parse, because a refusal is visible. The key now keeps the name it was written with, held to the shape of a name, and a client that only knows the closed set narrows it with `SecretIssuer.safeParse` where it renders — the same answer it used to be handed, with the scopes still beside it and a second unknown issuer still a second entry.

**The gate that filtered itself green was replaced in three capabilities by no gate in four.** Payments, storage, media and turnstile had no manifest↔registry test at all, and `@pithy-sh/secrets` had one over the capability's registry and none over the manager Worker's — so its Cloudflare account token declared both axes correctly and reached no client. Five of thirteen kit secrets declared neither origin nor rotation. All thirteen declare both now: the payment rails' bundle is obtained from four consoles and replaced by a human, R2 access-key pairs are made at Cloudflare and remade there because no API mints one, media's Images and Stream token and turnstile's widget secret are obtained from Cloudflare and rolled by Cloudflare's own API. Each capability states the invariant — every registry entry appears in the manifest, and says where it comes from and how it is replaced — and each was watched failing: an entry declaring neither axis was planted in all five, and all five went red naming it.
