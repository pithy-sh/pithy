---
"@pithy-sh/secrets": minor
---

An app can store a credential it mints during a request.

A keyspace models one credential per tenant, and nothing could write one. The sanctioned write was the manager Workflow the CLI dispatches, which is right for a secret an operator provisions and wrong for one an application mints on a request: a connect flow must return the public half in the same response that sealed the private one, and it cannot dispatch a Workflow and wait. The only in-Worker write was `SystemSecretsStore.put(keyedSecretName(name, key), …)` — a test utility standing in for an API. So adopters either reached past the capability or, as `pithy-sh/dashboard` did, hand-rolled an envelope and held the master key themselves.

`putKeyed`, `rotateKeyed` and `deleteKeyed` are on the accessor an app already holds. They seal through the same AES-256-GCM envelope, bound to the same `<entry>/<key>` context as every other secret, into the same row — so at-rest key rotation picks a member up like anything else, which is tested against a real store rather than assumed. The promise resolving is the persistence guarantee: nothing is queued, so a caller that awaits it knows the sealed half is stored before it returns the half that depends on it.

`putKeyed` creates and refuses an existing member. Create-or-replace would put "silently overwrite this tenant's live signing key" one typo away, and the loss is total and quiet. Adding a key while the old one still verifies is `rotateKeyed`, which appends a version and keeps the prior ones valid — the two-keys-during-rotation window `getKeyedVersions` exists to serve, and why a keyspace must declare `rotatable` to accept one. `{ replace: true }` is the explicit form for a credential that must not survive. `deleteKeyed` removes every version and the member's rotation history in one call, and is idempotent.

Writes are audited as `secrets/member_written`, `secrets/member_rotated` and `secrets/member_removed`, with the member key as the event's `tenant` and nothing about the value anywhere. The codes are the capability's; the recorder and the actor come from the call site, because an accessor has neither and an event that cannot say who wrote a credential is missing the point.

The manager Workflow is unchanged. This adds a form, it does not replace one.
