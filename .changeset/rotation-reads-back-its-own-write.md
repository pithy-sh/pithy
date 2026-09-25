---
"@pithy-sh/cloudflare": minor
"@pithy-sh/secrets": minor
"@pithy-sh/cli": minor
---

Scheduled master-key rotation now proves each write landed before anything depends on it, so a rotation can no longer leave an environment's stored secrets undecryptable.

The rotation writes the master-key envelope to Cloudflare Secrets Store over REST, and every consumer reads it back through the `SECRETS_ENCRYPTION_KEYS` binding. Nothing reconciled the two. A write addressed anywhere the binding does not read returned success, every row was re-encrypted under a key the binding had never received, and the store became unreadable at the next request with no error raised at the time. `putSecret` upserts, so a misaddressed write did not even fail — it created a second entry beside the real one and answered 200.

The order is the fix. A pass now publishes the new key under the **old** pointer, reads it back through the binding, and only then re-encrypts; the pointer advances after every row already uses it, and is read back again. A read-back that never shows the write aborts the pass — before a single row has been touched, when nothing has been lost. Waiting is expected rather than exceptional: each read-back is a bounded poll that sleeps between separate durable steps, so the wait is journalled and survives the instance being evicted mid-wait. Everything else retries for as long as Cloudflare takes. Measured against a real Secrets Store, a binding reflects a REST write in about 1.3 to 1.5 seconds, against a budget of a minute.

Retiring an old key is deferred a full generation. The version a pass supersedes is exactly the one a row that failed to re-encrypt is still sitting on, and the pass that created the successor is the worst moment to discover that.

`CloudflareSecretsStoreManager` gains an edit-only write that refuses to create, so a name that is not already in the store is a loud failure rather than a silent second entry. Every write may carry a non-secret stamp naming the pass that made it, which is the only thing about a value Cloudflare will show over REST.

Two at-rest passes can no longer overlap. Each of two concurrent passes confirmed its own write, and the loser's promoted write deleted the key every row was by then sealed under — a second, independent path to the same outage.

A Cloudflare 5xx or 429 now retries where it previously ended the pass; a 401 or 403 still stops it, so a revoked token fails rather than looping.

`pithy secrets verify` reports whether every stored row still decrypts, which key versions are in use, and any store entry no name this project composes accounts for. The capability also reports the last rotation's outcome on its manifest, so a pass that correctly aborts is visible the same day rather than whenever the cadence next elapses.

Security: a scheduled master-key rotation could persist a key the Worker never reads and re-encrypt every stored secret under it, leaving an environment's secrets undecryptable with no error raised.
