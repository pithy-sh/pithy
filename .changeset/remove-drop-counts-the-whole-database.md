---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

`pithy remove --drop` counts retained rows over the whole database, not the capability it drops.

A drop reversed one capability's migrations with a provider built from that capability alone, so both the preflight and the runner's own guard counted what it declared. A capability sharing `SECRETS` with the vault declares nothing, so its `down` ran while the vault held rows. A `down` that dropped the vault's table took it.

- **The count is database-wide, as a rollback's is.** The drop merges the Worker's whole composition with every Worker discovered beside it, and counts every table any of them declares retained. Only the dropped capability's migrations are reversed, and only its databases are visited, so dropping a capability from `DB` is not refused over the vault.
- **Core's `dropMigrations` takes the part and the database apart**: `dropMigrations(db, { database, reverse })`. It counts `database`, reverses `reverse`, and refuses to reverse a migration `database` does not carry.
