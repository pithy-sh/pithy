---
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
"@pithy-sh/cli": patch
---

Adding a language to email costs no configuration.

**The send Worker is now built with the kit's own email copy rather than sent it.** It is a separate deploy with no request and no access to `pithy.config.ts`, so anything it does not bundle has to be stamped into it as a variable — and the kit's own Spanish was doing exactly that, on every provision run, filling 61% of Cloudflare's 5120-byte per-variable ceiling with data that changes only when the kit releases. Held beside the English it translates, the host is deployed with it and a project that overrides nothing deploys no catalog variable at all.

**What travels is your diff.** Override one `email/` sentence and one sentence travels. Add a locale the kit ships and nothing travels, which is the property that makes adding languages free: the ceiling is no longer reachable by anything the kit writes, only by an override set large enough to outgrow a variable on its own.

**A kit sentence still lives in exactly one place, and which package that is now follows how it reaches a reader.** `@pithy-sh/i18n` keeps what no capability can hold — the error taxonomy, whose domains are not capability names, and the screens, which are copied into an adopter's repository rather than imported. A capability keeps its own domain in every language, which is what `Capability.messages` already meant and what the domain rule already said. It also keeps principle 4 intact in both directions: no capability imports another, which a dependency edge for this data would have broken.
