---
"@pithy-sh/cli": patch
---

`pithy doctor` names `pithy turnstile provision` only where it clears a stranded sitekey var.

Every stranded-var line ended "pithy turnstile provision … removes this". Provisioning edits its target Worker's `wrangler.jsonc` and `dev.json`, and refuses a Worker that composes no turnstile, which is where the old modes-from-one, vars-to-another split left them. Those lines never cleared. The project root's `.dev.vars`, where #53's writer put the dev sitekey, was not read at all.

Each finding now carries `removedBy` in `--json`: the Worker whose `pithy turnstile provision --worker <name>` clears it, or `null`. A `null` line says to delete the var by hand. The root `.dev.vars` is read and never edited.
