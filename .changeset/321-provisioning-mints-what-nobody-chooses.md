---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

Provisioning stopped to ask a human to generate random bytes.

`pithy provision --env staging --yes` created three databases and then printed three `pithy secrets create` commands. `--yes` had been passed. Each of those commands generates a random string; there is no decision in one.

The declaration was already there. A registry entry's `devValue` says whether a value is *arbitrary* — nothing outside the project has to agree with it — and that is a fact about the value, not about the environment. A session signing key is arbitrary in production for exactly the reason it is arbitrary on a laptop. Only local dev ever read the field.

Every environment reads it now. `pithy provision --env`, `pithy provision --feature` and `pithy secrets provision` create each declared-mintable `cf-secrets-store` secret and bind it in the same pass. `pithy feature` therefore stands up an environment with no follow-up commands, which is what it always said it did.

The limits are as deliberate as the change. Absence is checked first, always — an existing value is never replaced, because replacing a key-encryption key orphans everything sealed under it, and that is rotation rather than provisioning. A secret with no declaration stays a question for the human who can answer it: a generated value there authenticates against nothing and hides a real gap behind one that looks filled in. Nothing minted is printed, logged, or put in an audit event; the trail records that a secret was created and which entry it went to. Only the Secrets Store backend, because it answers *does this exist* authoritatively, and "never regenerate" has to be checkable.

Ask `isMintableSecret` rather than reading `devValue`, so the day that field is renamed there is one site to correct.
