---
"@pithy-sh/cli": patch
"@pithy-sh/turnstile": minor
---

`pithy turnstile provision` refuses before it creates anything.

The sitekey writer ran last, after the dev secret, the staging secret, a real production widget and the prod secret. Its refusals read only the config source, so a refused run had already minted a widget and stored both secrets. The docs said "Nothing is written". The rerun reused the widget and warned about a secret that was in fact stored. `deprovision` deleted the widgets and secrets before its sitekey edit refused, and left the stranded vars behind.

Every refusal is now decided first: a domain another widget covers, production widgets of which some exist and some do not, and a sitekey the writer would refuse. A production sitekey Cloudflare has not issued yet can only go into a string literal. `deprovision` checks its edit before it deletes anything. A config whose `turnstile({` does not open a line is refused with a sentence that says so.

`TurnstileProvisioner` gains `findProductionWidget` and `assertSitekeysWritable`, and `TurnstileDeprovisioner` gains `assertSitekeysWritable`. `PlannedSitekeys` is the shape they check.
