---
"@pithy-sh/email": patch
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

A remedy names only flags its command has.

The email host's boot and `pithy doctor` messages said `Run pithy secrets provision --env <env>.` for both host secrets, and `Run pithy email provision --env <env>.` for every binding and var. `pithy doctor`'s missing-suppression-list finding named `pithy email provision --env prod`, and `pithy deploy --kit` named `pithy <capability> provision --env <env>` for a skipped kit Worker. None of those commands takes `--env`. citty ignores a flag it does not declare, so an operator who typed `--env staging` provisioned every declared environment, production included, believing they had named one.

Each now names the command as it runs: `pithy secrets provision`, `pithy email provision`, `pithy <capability> provision`. `docs/commands/deploy.md` and `docs/commands/secrets.md` say the same.

The gate that holds action lines to the CLI read two packages and one key. It reads every package now: command names from every `action:` and host-env `command:`, flags from every string literal and every command page's prose.
