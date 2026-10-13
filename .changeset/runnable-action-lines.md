---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/auth": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/email": patch
"@pithy-sh/organization": patch
"@pithy-sh/payments": patch
"@pithy-sh/secrets": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

Every command an error or a report names now runs as written, and every `provision --json` ends in one outcome.

One builder, checked against the CLI's own command catalog, spells every `pithy` command an error, a report or a `fix` names: it names the Worker by its `apps/` directory, carries `--with-prerequisites` and the `--set` an option with no default needs, keeps the flags and values a rerun was given — `--json` included, and a caller's value shell-quoted exactly as it was passed, never refused as a placeholder — and never hands over a destructive or production command as a `fix` — that is said as a person's decision instead. A project with no Worker is told to create one first rather than handed a `pithy add` it would refuse.

`pithy secrets provision` provisions every environment, production included, so it is never a `fix` either. `pithy doctor --json` gives `secretBindings.missing[].fix` as `null` for a value the kit composes, and `provision --json` carries `pendingSecretsRemedy` as that decision rather than as a command to run.

`email`, `media`, `payments`, `storage`, `support` and `testers` `provision --json` now end in one outcome. A run that provisioned no environment writes only its error line, on stderr, and exits 3. Stdout is empty, where it used to carry a report. A run that went ahead writes only its report, and the report now carries `exitCode`. A script that read the report after an all-skipped run reads the error line instead.
