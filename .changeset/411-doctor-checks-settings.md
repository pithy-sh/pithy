---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
---

`pithy doctor` checks that your capabilities' settings work, not only that they are wired.

Config drift, required bindings, the migration ledger, project name, worker name, environments, dev vars, secret bindings — every check `doctor` had was a question about presence. None was a question about the value. So a project could be entirely green while `fromAddress` named a domain nobody onboarded, the link-signing key was never created, `BASE_URL` was staging's URL in production's config, `EMAIL_THEME` did not parse, or the suppression database did not exist. The option key was there, the binding was declared, the migrations were level, and no mail arrived.

A capability now declares a settings check on its `Capability` object, beside `health`. **Discovery keys on the capability instance and never on `pithy.manifest.json`** — `@pithy-sh/matchmaking` and `@pithy-sh/rating` are published capability packages that ship no manifest, and a manifest-keyed rule silently skips both. That is the same trap the version stamper documents, and it is not walked into twice.

**One schema, two readers.** The local tier validates through the same Zod object the capability's host Worker validates at boot: the Worker refuses to serve without it, `doctor` reports it before anything is deployed, and neither can drift from what the code actually requires — which is the failure a hand-written doctor check has every time.

**Two tiers, and three outcomes.** Local is pure and offline and always runs. Account costs a Cloudflare call. Both are faults: a local finding makes the project unhealthy and `doctor` exits non-zero, and an account finding does the same *when the account was reached*. When it cannot be reached, the account tier is reported as **skipped** — never as passed, and never as the account's fault when the failure was local. A check that never ran keeps the report verbose rather than letting silence read as a pass.

Every finding renders as a problem line and an action line naming the `pithy` command, config key or one-time account action that resolves it, and every finding and every skip appears in `--json`. The check never writes anything.

`@pithy-sh/email` declares the first one. A `Local delivery:` block joins it, backed by the same `deliveryPreflight` call `pithy dev` decides with, so the two commands cannot disagree about whether mail will go out. It never gates the exit — running the simulator is a choice — and it prints even in the terse report, because silence there reads as "of course it sends".

`secretBindings` and `devVars` are untouched. The account tier is simply where "does the store entry exist" is finally asked, which `secretBindings` deliberately refuses to.
