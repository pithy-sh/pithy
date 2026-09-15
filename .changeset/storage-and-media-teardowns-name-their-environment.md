---
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/media": patch
"@pithy-sh/cli": patch
---

`pithy storage deprovision` and `pithy media deprovision` tear down one named environment.

Both walked every declared environment. `--storage`, run to clear staging's uploads, emptied and deleted production's bucket with it, and `media` took production's `MEDIA` namespace too. Nothing asked, and there was no way to name one environment.

- **`--env` is required.** No default, no "all". With none, or one the project does not declare, it refuses before any credential is read and lists the environments it could act on. The same refusal `pithy secrets deprovision` gives, from the same function, now in `@pithy-sh/secrets`' `scope`.
- **Only that environment's worker comes down.** Its bucket, and for media its namespace, go only with `--storage`.
- **`--json` carries `env`.** `secrets deprovision` emits the same key rather than `environment`, so three teardowns and the eight commands that already said `env` agree.

The gate on D1 deletes now sees a delete made through `pithy feature destroy`'s provisioners, not only one that spells `deleteDatabase`. `feature destroy` itself still deletes a feature's own `SECRETS` and `EMAIL_SUPPRESSIONS` without a count, deliberately, and `docs/commands/feature.md` says so.
