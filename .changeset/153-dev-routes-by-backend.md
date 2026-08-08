---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

Dev resolves each secret from the backend its registry entry names, exactly as deployed does.

`secretsStore` had two branches. Deployed routed by `backend` — a `d1` secret from the encrypted per-environment row, a `cf-secrets-store` one from its binding. Dev routed by nothing: **every** secret came from an injected `.dev.vars` string whatever the registry said. `ENVIRONMENT` was what picked between them.

There is one branch now, and `ENVIRONMENT` decides nothing about resolution. Which environment's values a worker reads was already settled by which `SECRETS` D1 and which master key it is bound to; routing on the var as well was a second answer to a settled question, and it cost three things.

**`.dev.vars` stops carrying application secrets.** #149's dual-write is deleted in this commit. The file goes back to what wrangler says it is: env bindings, `UPPER_SNAKE`, one namespace. A kebab registry name sitting in it taught every adopter that one of the two conventions was a mistake. `pithy add`, the seeder, and `pithy turnstile provision` each wrote a copy there; none of them does now. The master key and the public Turnstile sitekeys stay, because those genuinely are env bindings, and a `cf-secrets-store` secret stays because there is no local Secrets Store and the binding is the only place a Worker can read one.

**Dev stops being a shape production never sees.** A `.dev.vars` value was decoded leniently, so a rotated secret collapsed to whichever version was current and `pithy secrets rotate --env dev` exercised a path only staging ran. Dev reads the same envelope the row holds, versions and all.

**A `d1` secret with no row but a binding of its own name is named, with the fix.** That is the one shape an upgrade produces — an adopter's pre-#149 `.dev.vars` line, or a Workers-runtime test injecting a `d1` value as a bare string. Reading it would put the asymmetry back; answering "not provisioned" about a value sitting right there is no better. It is `validation/invalid_input`, it names the secret, and it says to put the value in the dev secrets file and run `pithy seed`.

`cf-secrets-store` keeps accepting a plain string, permanently. `pithy token mint` writes a raw token, and an entry made by hand or by `wrangler secrets-store secret create` is a plain string too — there is no envelope to find there, and that is not a gap.

**The cost, stated plainly:** a Worker with any `d1` secret now needs its `SECRETS` D1 and a dev master key in dev too. `pithy add secrets` mints both, and a project composing a capability that declares a `d1` secret already needed them to deploy.

A registry secret still sitting in an adopter's `.dev.vars` is inert rather than competing, so the seeder and `pithy add` mint and seed beside it instead of standing down — standing down would leave the Worker with no session key at all. Nothing rewrites their file; `pithy doctor` names the stranded line every run, as a duplicate when the value has already moved and as the migration notice when it has not.

**`writeDevVars` gates every directory it writes beside, through the shared `ensureScaffoldPath` (#167).** The directories come from `discoverWorkers`, which builds `apps/<name>` from a `readdir` that follows whatever `apps` is — so a symlink at either planted a `.dev.vars` link, pointing at the project's shared credential file, inside a directory outside the project, and reported it as `linked`. The sibling in `feature/devVars.ts` documented that defect and had the gate; this module did not import it at all. One rule, one implementation, and a refused directory is reported as `undelivered` rather than thrown — by that line the project's own file is already written, and a planted link in a directory no Worker of theirs owns must not stop `pithy dev`.
