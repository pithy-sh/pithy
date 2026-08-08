---
"@pithy-sh/cli": patch
"@pithy-sh/secrets": patch
---

The dev secrets file is the source of the values a Worker receives (#179).

`generateDevVars` reads `<config>/<project>/secrets.jsonc` and the registry directly and materialises
every `cf-secrets-store` secret into each Worker's `.dev.vars`. It read a **copy** before: `pithy seed`
routed each value into `<config>/<project>/dev.json` under `vars`, so rotating a value in the file named
"the dev secrets file" did not reach a Worker until something re-seeded, a removed secret's plaintext
stayed in `dev.json` forever, and the generated header named a source it did not read.

`SECRETS_ENCRYPTION_KEYS` is a registry secret now — `cf-secrets-store`, `json` against
`EncryptionConfig`, and `bootstrap: true`, a new registry axis for the one secret a Worker reads straight
off its binding because it is what the envelope decoder needs to exist. `pithy add secrets` mints it into
`secrets.jsonc`; the local `SECRETS` store opens from there, and still opens for a project whose key is
in `dev.json` or in the project root's `.dev.vars`.

`dev.json` keeps only what no registry declares — a Turnstile sitekey has no other home. A registry name
there is dropped outright, which is what makes a deletion take effect. `pithy doctor` names each one.
