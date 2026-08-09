---
"@pithy-sh/cli": patch
---

Four commands resolved the default Cloudflare account, because the parameter was optional.

`pithy env`, `pithy migrate`, `pithy deploy`'s pending-migration count, and the `pithy testers` roster commands all reached `<config>/cloudflare.json` regardless of what the project's `pithy.config.ts` named. A project on a `cloudflare.accountName` got another account's credentials from every one of them — no name, no pin, no refusal, which is the exact state #206 exists to prevent. `pithy migrate --env staging` is the one that matters: `migrateProject`'s own docstring says a remote migration alters a real schema and the wrong credentials run it against another company's database, and the command that invokes it did not supply the account.

All four now pass `projectCloudflareAccount(projectDir)`. Two projects on one machine naming different accounts each resolve their own credentials file, and a pinned `cloudflare.accountId` that disagrees refuses before any network call.

**The cause was that the parameter was optional, not that four people forgot.** `account?: T | null` reintroduces the failure mode a required argument removed: `null` is the deliberate "this project names none", an omission is indistinguishable from it, and it costs nothing to write. `buildEnvInventory` now takes a **required** `account`, so omitting it is a type error.

`cloudflare/accountArgument.test.ts` — the gate holding every deliberate `account: null` to a written reason — could not see an omission, which is why all four passed it. It now walks the shipped source for *optional* account declarations too, in both shapes the compiler permits: an `account?:` property and an `account: … = null` default. Four remain, each listed with what it would cost to make it required. A fifth cannot appear quietly.

`pithy env`'s `accountId` schema said the value comes "from `.dev.vars` or the environment". `.dev.vars` has not been a credential source since #182; it names the file it actually reads.
