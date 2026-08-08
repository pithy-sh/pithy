---
"@pithy-sh/cli": minor
---

`pithy doctor` notices a Worker that is getting nothing.

An upgraded project could have every dev value in its root `.dev.vars`, every generated `apps/<worker>/.dev.vars` written with a header and no values, and a clean `pithy doctor`. The first thing that said otherwise was a 500 from a running Worker: `Missing required bindings: …`. Since #154 the root file is not a source for the generated one, so an upgraded project's values sit one file away from everything that would use them — and nothing said so.

Three things are reported now, all of them from local files, none of them fatal to the exit:

- **A Worker whose generated `.dev.vars` carries no values**, by name. A Worker in that state cannot serve a request, and it was one `stat` and one parse away from being detectable.
- **A registry secret in the root `.dev.vars`, whatever its backend.** The check reached `backend: "d1"` only, on the grounds that `CLOUDFLARE_API_TOKEN` has no local Secrets Store to live in — true of that one name, not of the backend, so `cf-secrets-store` secrets sat there unreported. Backend decides where a *seeded* value lands; it never decided which file a value belongs in. `CLOUDFLARE_ENV_KEYS` — the list the CLI's own readers use — is what decides that now, in one place both checks call.
- **A key in the root `.dev.vars` that nothing reads**: not a Cloudflare credential, not a registry secret, not declared by anything this project composes. A key the project *does* compose — `SECRETS_ENCRYPTION_KEYS` above all — is named as stranded rather than as deletable, because "nothing reads this" cannot be said safely without knowing what does.

Every key in that file is classified, and the classification is total: a key belongs to exactly one of those states, and the two silent ones are named rather than defaulted. That is the gate — the previous check failed by having a class of key that reached no branch at all.

Reported, never fixed. #154 said migration is reported rather than automatic and that is still the right call; reported now means reported.
