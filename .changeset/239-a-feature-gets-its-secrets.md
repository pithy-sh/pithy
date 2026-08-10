---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

A feature environment gets its secrets.

`pithy provision --feature` created a real, deployable environment — D1, KV, R2, environment-scoped script names, service bindings — and touched secrets not at all. So a feature Worker composing `secrets` deployed and failed on its first request:

```
{"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
```

Worse than the same gap in staging, because the adopter chose staging. A feature environment is created by pithy, from a branch name, with every other resource wired automatically — so there was no reason to think secrets were the one thing to arrange by hand, and nothing said so.

**A feature gets its own master key, and teardown takes it.** `pithy secrets deprovision` preserves a key unless explicitly asked, because losing it orphans every secret encrypted under it. For an ephemeral environment that reasoning inverts: nothing outlives the feature, so the key is the feature's and goes with it. `pithy feature destroy` removes every entry the feature could have named, by recomputed name, and leaves staging's and prod's alone — asserted, because the account's Secrets Store is flat and the name is the only partition there is.

**`ManagedEnvironment` does not widen, and the argument is recorded in the source.** Since #241 that type *is* the set the project declared, and everything iterating it multiplies with it — most of all a manager Worker with its own D1 and its own rotation cron, per environment. One per open pull request is not a cost a branch should carry. So the feature takes the narrow route: a key of its own and the bindings that reach it, and none of the durable machinery. The consequence is stated where an adopter meets it — a feature has no manager, so a secret it needs beyond the master key is reported as unbound with the command that creates it.

**A `global` secret is bound, never copied.** It is one account-level value every environment binds; minting a feature's own would be a second copy of a value defined as one.

The writer underneath is shared. `ProvisionScope` gained `secretEntry(secret, scope)`, so an entry name comes from the same object the resource names and the wrangler stanza do, and `applyProvisionedEnv` writes the `secrets_store_secrets` stanza for whichever scope it was handed. A declared secret whose entry has not been created is **reported rather than bound**: wrangler refuses a config naming an absent entry, so binding it would turn one missing value into a failed deploy of the whole Worker.

Both provisioning writers now emit through the one JSONC printer (#249) rather than a raw `stringify`, and `src/ci/jsoncWriters.test.ts` states that as a rule about the call rather than a list of files — the gate that would have caught this one, which did not exist when #249 landed.
