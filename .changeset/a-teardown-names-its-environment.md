---
"@pithy-sh/core": patch
"@pithy-sh/secrets": patch
"@pithy-sh/email": patch
"@pithy-sh/cli": patch
---

`pithy secrets deprovision` tears down one named environment, and counts the vault first.

It used to walk every declared environment. One run, typed to clean up staging, deleted production's secrets database with it, and nothing asked.

- **`--env` is required.** There is no default and no "all". With none, it refuses and lists the environments it could act on. Production is never in a default set, because there is no default set.
- **A vault holding rows is counted before anything goes.** The refusal names the database and the count, and `--destroy-retained <n>` must match it. The same guard `pithy migrate --rollback` spends. It is counted again at the delete, so a row written in between is refused.
- **The shared manager token goes with the last manager only.** Removing it for staging would have failed every rotation in prod.
- **`pithy email deprovision --suppression` gets the same count.** The suppression list is retained too. It is counted before the first worker goes, and `--destroy-retained <n>` must match.

`--json` for `secrets deprovision` now carries `environment` and `managerTokenDeleted`.
