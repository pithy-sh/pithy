---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
---

`pithy seed --redo` rebuilds an environment's data from scratch: roll every migration back, run them all forward again, then seed. Seeding is deliberately non-destructive — D1 is `INSERT OR IGNORE`, KV skips an existing key — so editing a fixture's values and re-seeding silently did nothing. `--redo` is the way to make edited fixtures actually land. Because the schema comes back empty, the ordinary writes just work.

**It is destructive: every row in every table the migration registry owns is gone, hand-inserted data included.** So it carries its own gate, stricter than the seed gate. `--yes` means "this is not dev" and was designed to authorize an additive write; it does not authorize a drop. Any non-`dev` reset needs the exact phrase `yes, i really want to reset <env>`, passed as `--confirm-reset` or typed at a prompt that states the loss first. The phrase names its environment, so one env's cannot be pasted at another. `dev` stays free. CI still automates it by passing the flag. Every reset is audited before the drop begins, at `critical` severity off `dev`.

Adds `resetMigrations` to `@pithy-sh/core`, and `resetProject`/`previewReset` to the CLI's migration layer — the same plan and driver as `migrate`, so a reset works against local Miniflare and remote D1 alike.
