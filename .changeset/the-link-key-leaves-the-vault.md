---
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

`email-link-signing-key` is a Secrets Store entry per environment, and a link verifies only where it was minted.

It was an encrypted row in each environment's D1 vault, declared `global`. A rollback, a `seed --redo` or a teardown an operator agrees to reaches the vault, and a staging rollback took the key. It is the one secret whose loss outlives the system: every link already in an inbox stops verifying.

- **The key lives outside every D1.** `backend: "cf-secrets-store"`, `scope: "environment"`: one entry, `<project>-<env>-email-link-signing-key`, none shared. `pithy secrets provision` creates it when absent and binds it in the app Worker; `pithy email provision` binds the same entry in the email host. The host signs, the app verifies.
- **A token names its audience.** Callback tokens are `v: 2` and carry `aud`, the origin their links point at. The routes refuse a token presented anywhere else, so a key misconfigured as shared still cannot let a staging link act on production — the unsubscribe route included, which writes into the suppression list both environments bind.
- **Rotation keeps its versions.** The entry holds the `{ currentVersion, versions }` envelope, so a link minted under a retained previous version still verifies.
- **`pithy doctor` reports the move.** A missing Secrets Store entry, and a key still held in an environment's D1 vault, are each a `Settings:` finding for that environment.
- **`pithy secrets rm --backend d1`** removes the row a moved declaration left behind, one named environment at a time. A plain `rm` routes by the declaration and would delete the live entry.

**Moving the key invalidates links already sent.** The D1 value is sealed under a master key no command can read, so it cannot be carried into the new entry as a previous version, and links minted before this release name no audience. They answer `email/invalid_token`. The path is in `docs/commands/secrets.md#moving-a-secret-off-d1`.
