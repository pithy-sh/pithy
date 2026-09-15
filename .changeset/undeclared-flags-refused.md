---
"@pithy-sh/cli": minor
"@pithy-sh/email": patch
"@pithy-sh/core": patch
---

Every `pithy` command refuses a flag it does not declare. `pithy doctor --bogus-flag yes` exited 0 with the output of `pithy doctor`, and a typo in a safety flag ran the unsafe version. It now exits 1 with `Unknown flag: --bogus-flag.` and the flags the command does take; under `--json` the refusal is one `{ "error": … }` line, `validation/invalid_input`, with an `unrecognized_keys` issue per flag. A group refuses one too, so `pithy token --json` is no longer answered with usage. The check runs before `--version` and the hidden root flags, so neither prints over a typo.

Remedies that cited an undeclared `--env` no longer do: the email settings check and host-env report name `pithy email provision` and `pithy secrets provision`, and `pithy deploy --kit` names `pithy <capability> provision`. Each spans every environment and takes no `--env`.
