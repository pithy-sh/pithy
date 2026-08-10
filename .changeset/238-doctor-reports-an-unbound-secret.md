---
"@pithy-sh/cli": minor
---

`doctor` reports a deployed environment that binds no Secrets Store entry, and provisioning stops binding only half of them.

Two things were left open when the stanza writer landed. Both close here.

**`pithy doctor` names a `cf-secrets-store` registry secret with no binding in a deployed stanza**, and names the command that writes it. That is the safety net for every project that predates the stanza existing at all — including the adopter who found this by reading their own `wrangler.jsonc` and asking where the binding was. Until now the only thing that reported a missing binding was the Worker's own response to its first request:

```
{"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
```

It reads files only and never asks the store. Whether an *entry* exists is provisioning's question, and a declared secret whose entry has not been written is reported rather than bound, because wrangler refuses a config naming an absent entry. `dev` never appears, and not by being filtered: the environments walked are the ones the project declares, and local dev materialises these secrets into each Worker's generated `.dev.vars` instead. It reports and never fails the exit — a project that has composed `secrets` and not yet provisioned is a step not yet taken, not a contradiction.

**And the writer was binding the master key and nothing else.** `workerSecretRegistry` read the `secrets` capability's own slice rather than the aggregate every capability contributes, so a `cf-secrets-store` secret declared by `auth`, or by the adopter's own `app` capability, got a binding from no command at all — the dashboard's `CONNECTION_KEY_ENCRYPTION_KEY` and `RELEASE_INGEST_SECRET` among them. It now reads the same aggregate the Worker composes and `pithy seed` already resolves against, so the Worker boots with the bindings it will actually read rather than failing at the first read of one. Composing `secrets` is still the gate: a Worker with no store to read from has nothing to bind.

Which registry entries need a binding is one predicate now, shared by the writer and the check — so a `doctor` that reported a binding provisioning would never write, or missed one it would, is not a state the two can reach.
