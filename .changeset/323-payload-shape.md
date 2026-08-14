---
"@pithy-sh/secrets": minor
"@pithy-sh/cli": minor
---

A secret's entry in `secrets.jsonc` is the payload its destination receives.

Nothing wraps it, nothing unwraps it, and no secret is an exception. The file stated a `{ currentVersion, versions }` envelope for every secret, including `SECRETS_ENCRYPTION_KEYS` — whose binding is read before any envelope decoder exists, so the seeder took the envelope off again on the way out. One concept with two `currentVersion` fields, carrying no information, and reported as file corruption by two readers in a row.

`SECRETS_ENCRYPTION_KEYS` is now stated as a bare `EncryptionConfig`. `bindingValue()` is gone, along with the `bootstrap` branch it existed to switch on: there is no asymmetry left. `devSecretPayload` is the one reading of an entry, and it answers every form anything downstream needs — the payload, the string a binding carries, the envelope a D1 row holds, the current value. The registry entry decides which shape a name takes, so a reader determines any secret's shape without a special case.

**The reader shipped before the writer**, which is the one thing the earlier review of this was right about: the old wrapped shape still reads, so a project that has not upgraded is not broken by a newer reader. `pithy seed` — and so `pithy dev` and `pithy add` — restates a wrapped entry in place and says which one it moved. The binding a Worker receives is byte-identical across the upgrade; migrating is not a key rotation, and a key rotation here orphans every secret encrypted under the old one.

`loadDevSecrets` takes the registry when a caller has one, and `pithy secrets edit` now resolves and passes it — an edit is judged against the payload each secret's destination takes, where before no reader of that file could judge a shape at all. Without a registry the file is still checked as JSONC, because the project whose config will not load is exactly when somebody reaches for that command.

`defineSecretRegistry` refuses `bootstrap` beside `devValue`. Nothing may mint the value every other secret is read through.
