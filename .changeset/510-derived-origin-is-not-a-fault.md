---
"@pithy-sh/email": patch
---

`pithy doctor` no longer tells a correctly-configured project to hardcode an origin.

The recommended shape is `email({ baseUrl: PUBLIC_ORIGIN })` over `originFor(compositionEnvironment(), DOMAINS)`, and `doctor` loads a config **once, under `dev`** — an environment `domains` declares by design, so the derived value is `http://localhost`. Compared against the origins staging and prod declare it matched neither, and the report told the project to set `baseUrl` to one of them **by name**.

That is the single-origin mistake `docs/CLI.md` exists to prevent, offered to the projects that got it right: write one environment's origin into that key and a staging deploy mails real users links into production, an unsubscribe from a staging test unsubscribes that person in production. Easy to follow, named two specific origins, and wrong.

A loopback origin is now passed over. A hardcoded one is indistinguishable from a derived one at that point — same string, same key, no environment in hand — so the question stays where it can be answered: `pithy deploy --env` refuses an environment whose origin its config does not declare, and `Origins:` reports the placeholder before a deploy is attempted.
