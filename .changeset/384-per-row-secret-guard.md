---
"@pithy-sh/secrets": patch
---

A secret that will not decrypt costs its own name, and no other.

`SystemSecretsStore.getValues` is the one call every `d1` secret in an application resolves through, at boot, in a single batch. It decrypted the rows in a bare loop. One row that would not open threw out of the whole read, and `secretsStore` held that throw against **every** `d1` name it had asked for — including the ones that opened cleanly.

Neither cause is exotic. A corrupt ciphertext is a bad write or a bad restore. A `keyVersion` no longer in `SECRETS_ENCRYPTION_KEYS` is a master-key rotation that pruned a version some row still names, which is the one job this package runs on a cron.

`#170` established that a failure belongs to its secret. That was true of a **missing** row and not of an **unreadable** one — a narrower guarantee than the sentence reads, and narrower in the direction nobody would guess from it. It is true of both now.

It is also why `#381`'s own title case was only half covered. `#381` split the OAuth provider credentials off the sign-in precondition, so a provider that will not resolve no longer ends email/password and magic-link sign-in. An *unreadable* `auth-github-credentials` still did, one layer lower: `auth-session-secret` was in the same batch and died with it. Correct once the batch had failed, and the batch should not have failed.

Each row now lands as a `StoredSecretValue` — `{ state: "readable", value }` or `{ state: "unreadable" }` — filed under its own name. **The state rides on the value**, so a caller cannot reach a plaintext without narrowing and forgetting the unreadable case is a compile error rather than a silent empty. **Absent is a third fact and stays outside the union**: a name with no row is simply not a key in the record. Missing and unreadable are different faults with different remedies — provision it, versus investigate the row or re-seal it — and the reads tell them apart, `secrets/not_found` against `secrets/crypto_failed`.

**The guard's `catch` takes no binding.** A decryption failure's own text names the key version it tried and the context it tried under. None of it travels: there is no error object in scope to attach as a `cause` or fold into a `detail`, so it is impossible to reach rather than merely unused. The refusal is built fresh from the secret's name.

`getValue` is unchanged for its callers and still answers `undefined` for a name with no row. A stored row that will not open throws, naming the secret — what it must not do is say "not provisioned" about a value that is sitting right there.
