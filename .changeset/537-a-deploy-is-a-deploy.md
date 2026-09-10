---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": patch
---

`pithy deploy` deploys everything the project deploys, and re-uploads a kit Worker only when it changed.

A capability that owns Workflows ships a Worker of its own, and nothing decided whether it needed redeploying — `deployWorker` resolved the template and shelled `wrangler deploy` unconditionally. That left an adopter's CI two bad options, and both were in use. Run `pithy <capability> provision` on every deploy and you re-upload an unchanged Worker, version the script hosting your durable jobs, and pay a full provisioning pass — buckets, namespaces, databases, secrets, Email Routing rules — on every push to main. Leave it out and the Worker goes stale silently: it has no request and no access to `pithy.config.ts`, so its configuration is stamped into its vars at provision time. Edit a theme, fix a translation, move a base URL, and `pithy deploy` ships it to your Worker while the kit's keeps sending the old one. Nothing fails, and `pithy doctor` does not catch it — the `Settings:` tier validates the project's own files against the capability's schema, never the deployed Worker.

Over-deploying is wasteful and loud. Under-deploying is free and silent.

Every kit Worker now carries `PITHY_DEPLOY_STAMP` — the deployed package version and a hash of the resolved config, written inside the config wrangler deploys, so the bundle and its stamp land in one operation and the stamp cannot claim a deploy that did not happen. Two inputs because they answer different questions: a kit upgrade moves the version, a theme edit moves only the hash, and the config half is the silent one. The hash sorts keys recursively before serializing and excludes the stamp var from its own input.

**When in doubt, deploy.** No stamp, an unreadable stamp, no Worker, an unreachable account, a package whose version cannot be read — every one of them deploys, each with its own reason on the row. A false redeploy costs seconds; a false skip is silent, so the gate can never stop a deploy for a reason nobody can see. Worst case it degrades to the old behavior.

The gate lives in the shared deploy path, so `pithy <capability> provision` inherits it with no flag — and on a first provision there is no stamp, so it deploys. `pithy deploy` now covers both sets by default, with `--apps`, `--kit` and `--force`, as two named steps so CI gets separate exit codes and a failure that says which half broke. Your Workers are never gated: your code is the thing that changed. There is no `--if-changed` in any spelling — a flag that can only ever be true is one somebody eventually leaves off believing it does something.

**In `dev` the kit's Workers run locally under `pithy dev`, so `pithy deploy --env dev` ships your Workers and says so.** `domains` has no `dev` key by design, `pithy <capability> provision` excludes `dev` by refusal, and the Worker that would run there is materialized by `pithy dev` — so there is nothing to deploy and nothing to gate. Narrowing *to* the kit half in dev is refused rather than quietly doing nothing.

Deploying is still not provisioning: `pithy deploy --kit` creates nothing. And a project whose `apps/<name>/pithy.config.ts` will not load now fails the run by name — its capabilities are invisible, so its Workers would silently not ship, which is the staleness this closes arriving one level up.
