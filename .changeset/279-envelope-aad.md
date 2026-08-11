---
"@pithy-sh/secrets": minor
---

Seal the secret's name into its ciphertext, so a moved row does not open.

The `d1` store's AES-GCM envelope bound no authenticated data, so a ciphertext was valid under the master key alone: one lifted from a row and written into another decrypted cleanly, and the envelope had no opinion about whether it belonged there. Everything deciding which secret a caller got was the query above it, and a bug there was a disclosure rather than a failure.

`encryptValue` and `decryptValue` now bind the secret's **stored name** — for a keyspace member, the whole `<entry>/<key>`, so one tenant's credential does not open under another tenant's key. The check happens inside the primitive and holds however the query above it is later rewritten. A mismatch is a `secrets/crypto_failed` `PithyError` whose `detail` names the context the decrypt was attempted under; the public message stays generic, because GCM cannot tell a wrong name from a wrong key and pretending otherwise would be an oracle.

The name is what is bound because it is the row's identity and nothing renames it: a rename is a `put` under the new name plus a `delete` of the old, which re-seals through the plaintext. `UPDATE ... SET name` in SQL leaves a row nothing can open — the property working, not a regression.

**Ciphertexts written before this do not open.** No compatibility path, no unbound fallback: nothing is published and no adopter holds production values, so accepting an unbound ciphertext would buy nothing and leave the hole permanently reachable. Any dev or staging store seeded before this upgrade must be re-seeded.

Both signatures changed. `encryptValue(config, name, plaintext)`, and `decryptValue(config, name, envelope)` takes the `{ encryptedValue, iv, keyVersion }` row shape rather than three positional strings — so the name cannot be transposed with the IV at a call site.
