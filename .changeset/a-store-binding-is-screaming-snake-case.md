---
"@pithy-sh/secrets": patch
"@pithy-sh/email": patch
"@pithy-sh/cli": patch
---

A Secrets Store binding is its key in SCREAMING_SNAKE_CASE.

`pithy secrets provision` wrote `"binding": "email-link-signing-key"` into `wrangler.jsonc`. A binding is an environment name, and environment names are capitals. The kit read and wrote a `cf-secrets-store` secret's registry key as its binding, verbatim, which went unnoticed while every such key happened to be in capitals — until #596 moved the kebab-case link-signing key into the store.

`secretBindingName` in `@pithy-sh/secrets` derives the binding now: every character that is not an ASCII letter or digit becomes `_`, then the whole is uppercased. `email-link-signing-key` binds as `EMAIL_LINK_SIGNING_KEY`, and `CLOUDFLARE_API_TOKEN` as itself. No word boundary is guessed, so a camelCase key is not split. The stanza writer, doctor's stanza check, the runtime reader, `.dev.vars` generation and the email host's template and env schema all go through it. The Secrets Store entry keeps the key's name: `<project>-<env>-email-link-signing-key`.

`defineSecretRegistry` and `aggregateSecretRegistries` refuse two store secrets that derive one binding, and a key whose binding would start with a digit. Two Workers whose secrets derive one binding get neither value in `.dev.vars`, and `pithy dev` names both secrets and both Workers. `pithy provision --json` and doctor's `secretBindings` findings carry the `secret` beside its `binding`, and a remedy names `pithy secrets create <secret>`.
