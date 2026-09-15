---
"@pithy-sh/core": patch
"@pithy-sh/secrets": patch
"@pithy-sh/email": patch
"@pithy-sh/cli": patch
---

A rollback no longer empties the secrets vault, or production's suppression list.

`pithy migrate --rollback` steps back one migration in every database in scope. The secrets database's whole
history is one migration whose `down` drops `pithy_secrets_system_secrets`, so any rollback destroyed every
stored secret in place. And `EMAIL_SUPPRESSIONS` is one database bound by every environment, so a staging
rollback also dropped production's suppression list.

A capability now declares a table **retained** (`DatabaseSpec.retained`). `secrets` retains both vault tables;
`email` retains `pithy_email_suppressions`. No `down` runs against a database while a retained table in it
holds rows. A rollback, a `seed --redo` reset and a `remove --drop` all refuse, name each table and the row
count, and move nothing. `--destroy-retained <n>` overrides, and `n` must equal the printed count. The refusal
lives in the migration runner, recorded on each migration's own `down`, so a new command that reverses
migrations inherits it.

A rollback or reset scoped to one environment keeps any database another environment's stanza also binds,
and says so. `--binding` narrows a run to one database. A rollback outside `dev` needs the phrase
`yes, i really want to roll back <env>` (`--confirm-rollback`). After a partial rollback failure the remedy
points at `pithy doctor`, not at a second rollback.

`--json` gains `workers[].databases[].boundBy` on `migrate`, and `reset[].retained` and `reset[].boundBy` on
`seed --redo`.
