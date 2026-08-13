---
"@pithy-sh/core": minor
"@pithy-sh/secrets": minor
"@pithy-sh/auth": patch
"@pithy-sh/email": patch
---

A secret says where it comes from and how it is replaced.

The registry has always known which secrets the kit cannot mint — no `devValue` — and nothing about how a human is supposed to get one. So `doctor` said *not set*, `secrets ls` said *not set*, and every client that wanted to say more carried its own table of names that went stale the moment a capability was added.

Two axes, on the registry entry and mirrored into `pithy.manifest.json` as `secrets[]`, the route `devSecrets` already proved. **`origin`** is `minted`, `helped`, or `obtained`. **`rotation`** is `local`, `provider`, or `manual`. They are separate because neither follows from the other: a GitLab token is `obtained` and rotates by `provider`; an OAuth client secret is `obtained` and rotates only by a human. A Cloudflare account token is `helped` to create and `provider` to roll — one secret, two mechanisms, which is the case one axis cannot express.

`SecretRecipe` is a union, not an enum, and `SECRETS_ENCRYPTION_KEYS` is why. It is minted — by `initialMasterKeyConfig` — and its value is an `EncryptionConfig`, so a recipe that knew only `random` would have failed to describe the first secret it was drafted around. `recipe: "encryptionConfig"` says both halves, and the entry still carries no `devValue`, because nothing arbitrary fills it.

One axis, enforced. `defineSecretRegistry` refuses an origin without a rotation, a minted secret that does not rotate locally, a `devValue` without a random mint or a random mint without a `devValue`, and a structured mint on a text entry. `secrets()` now runs its merged registry through that check, so the master key is held to the rules every adopter's secret already was.

A `documentation` link is `https:` and nothing else. `z.url()` accepts `javascript:alert(1)`, and this field is read out of `node_modules` and rendered as an anchor an operator clicks.

An unrecognised issuer parses to `other` rather than failing, so a manifest written by a capability added tomorrow still renders in a client built today.

Auth's four OAuth pairs now name the settings page a human goes to. Auth's session secret and email's link signing key declare the random mint they already performed. The secrets manager's Cloudflare token declares the permission groups `pithy token mint secrets` asks for, so nothing downstream repeats them.
