---
"@pithy-sh/cli": minor
---

`pithy deploy` refuses an environment that answers on an origin nothing declares, and a declared domain closes `workers.dev`.

**Every origin a deployed Worker answers on is one its configuration names.** That is the invariant, and nothing enforced it. Anything derived from an environment's public origin — an auth `baseURL`, an OAuth callback, a magic-link URL, a CSRF allowed-origin — has to answer "what is this environment's origin?", and when the config answers nothing every caller invents one. The first adopter shipped the dangerous invention: a staging deploy that emailed real users magic links into **production**.

Two shapes are refused, at `pithy deploy --env <name>`, before anything is built or spawned — the same shape as its refusal of a binding with no id.

**No origin at all.** No `domains` declaration, no `routes` pattern, no `vars.BASE_URL`. The refusal names the Worker, the environment, and the edit: declare `domains.<env>`, or set `vars.BASE_URL`. Two answers because `WorkerDomains` has keys for `staging` and `prod` only, and telling a project on a custom declared environment to declare a domain would send it to a config that would not validate.

**`workers.dev` left open beside a custom domain.** A Worker with a declared domain still answers on `<name>.<subdomain>.workers.dev`: wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change it, and `preview_urls` then follows `workers_dev`, so every deployed version is reachable there too. On that second origin `vars.BASE_URL` names the other host — so OAuth callbacks and magic links point away from the host in use — and the CSRF same-origin gate refuses exactly the requests that establish who you are. Reachable, and broken in that half. Anything bound to the hostname rather than the script, a WAF rule or an Access policy or a per-hostname rate limit, does not apply there at all.

So `pithy init` and `pithy worker add` now write `"workers_dev": false` beside every domain they declare — visible and diffable, in the same file the route and `BASE_URL` are generated into. Unlike those two it is written only when the key is absent: **the fault is the absence of a decision, not the decision.** A team that wants the `workers.dev` URL for staging until DNS is cut over writes `"workers_dev": true`, and a named origin satisfies the invariant exactly as a domain does.

`workers.dev` is therefore supported rather than refused, and the answer to "is it derivable?" is that it must be *stated*: an adopter with no custom domain sets `vars.BASE_URL` to their `workers.dev` URL, which is the one place an origin comes from and the one the resolver already reads. What dies is the third state, where the origin is neither declared nor derivable and each caller guesses.

`pithy doctor` reports both faults so they are findable before a deploy is attempted. Only the `workers.dev` one fails the exit: it is a live origin this repo's own config does not name, established from that config alone. Having no origin yet is the state every project is in before it has a domain, and failing it would turn `pithy doctor` red on day one for everyone.

A feature environment is exempt. It is ephemeral, has no declared domain by design, and `workers.dev` is how it is reached.
