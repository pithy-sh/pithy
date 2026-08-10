---
"@pithy-sh/cli": minor
---

A deployed Worker gets its Secrets Store bindings.

An adopter's Worker never got a `secrets_store_secrets` stanza. Nothing wrote one, for any environment, at any point — every writer in the kit targeted a kit-internal host Worker, never `apps/<worker>/wrangler.jsonc`. So a project deployed to staging or prod and the Worker booted without `SECRETS_ENCRYPTION_KEYS`, failing the way an unprovisioned local Worker does, at the first request, with no message anywhere:

```
{"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
```

**The skip was right and the outcome was wrong.** `core/src/capability/bindings.ts` says why `pithy add` cannot write the entry: it needs a `store_id` and a `secret_name` that do not exist until an account has been reached, and "telling anyone to add one of these to `wrangler.jsonc` sends them somewhere the value does not exist". That was a decision about *when*, and it was implemented as a decision about *whether*. The thing being deferred to did not exist.

It does now, and two commands reach it. `pithy provision --env <name>` writes the stanza as it wires the environment. `pithy secrets provision` writes or corrects it for every declared environment once the entries certainly exist — the five cases `ensureSecretsStoreId` cannot resolve at `add` time, and every project that predates the stanza existing at all. Both upsert by binding, so an existing entry is corrected rather than duplicated, and a binding the registry does not declare is left exactly where the adopter put it.

**`dev` is excluded deliberately, and the reason is in the source.** Local dev materialises every `cf-secrets-store` secret into the generated `.dev.vars` (#179), so a stanza there would name store entries a local run never reads.

**A declared secret whose entry has not been created is reported, not bound.** Wrangler refuses a config naming an absent entry, so binding one would turn a single missing value into a failed deploy of the whole Worker. `pithy provision` names it and the command that creates it.

Not closed here: `pithy add secrets` does not write the stanza at the moment it resolves the store id, and `pithy doctor` does not yet report a `cf-secrets-store` registry secret with no binding in a deployed stanza. Both remain on #238.
