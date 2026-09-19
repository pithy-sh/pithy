---
"@pithy-sh/core": patch
"@pithy-sh/cli": minor
"@pithy-sh/email": patch
"@pithy-sh/secrets": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/media": patch
"@pithy-sh/storage": patch
"@pithy-sh/payments": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/vector": patch
---

A feature deployment has an address. A feature Worker answers on `https://<script>.<subdomain>.workers.dev`, and `pithy provision --feature` now derives that from the Worker's script name and the account's `workers.dev` subdomain, through the same resolver staging and prod use, and stamps it as the feature stanza's `vars.BASE_URL`. `originFor` reads that stamp inside a feature deployment, so the scaffolded `PUBLIC_ORIGIN` — and with it auth's base URL, email's links and payments' return URLs — is the feature's own origin instead of `http://localhost`. Only a `workers.dev` https origin is read, so a `BASE_URL` a feature inherits from the top level is never taken for its own. A declared environment never falls back to `workers.dev`. `pithy dashboard connect --env feature` registers the same address.

A feature answers on that address and nothing else. Its generated stanza states `routes: []`, because wrangler inherits a top-level `routes` into every environment that sets none: a branch deploy took the project's custom domain, and with routes and no `workers_dev` it got no `workers.dev` address at all. A top-level `workers_dev: false`, which wrangler also inherits, means no address. `pithy deploy --env feature` verifies against the feature's own origin, read from the generated config.

A feature deployment sends a magic link, and the link signs the person in.

- **Every kit Worker a feature composes is provisioned for it**, not email's alone: the secrets manager, email, media, storage, payments, support, testers and vector — whatever the registry names that the branch composes. Each is deployed through the registry entry, resolver and gated deploy `pithy deploy` ships a declared environment's with, handed the feature, so its script, its Workflows, its buckets, its Vectorize indexes and its store entries are `<project>-f<issue>-<slug>-…`. A vector host's indexes are created for the feature with their declared shape and bound on its app Worker. A host any of whose account-wide names is not the feature's fails rather than deploys. `pithy deploy --env feature` redeploys them; `pithy feature destroy` deletes every one, and every Workflow they host, explicitly and first.
- **A feature's secrets are created the way staging's and prod's are.** It gets its own manager token, master key and secrets manager, through the provisioner `pithy secrets provision` uses, and the manager creates every generated `d1` secret through the same `mintDeclaredSecrets` pass: probed first, written with `create`, never over a value that is there. The CLI never holds a value, nothing depends on which run created the key, and a run that fails anywhere after the key exists is finished by the next one. The feature-only sealing path is gone. A manager's `create` is now one insert-if-absent, so two concurrent runs leave one value and the loser is told it exists.
- **Nothing is shared between a feature and any other environment.** Every store entry is the feature's own, a `global` secret's included, and so is its manager's CF API token. Every rate limiter in a feature stanza — copied from the top level, or declared under a tracked `env.feature` — gets a `namespace_id` of the feature's own, so a branch no longer spends production's per-IP budget; an id the tracked config already uses is refused.
- **The app Worker is bound only to the hosts that deployed.** The bindings are written after the deploy, so a host that failed leaves none for the next deploy to ship, and a re-run whose host now fails takes back the one an earlier run wrote.
- **An app Worker whose directory would give it a kit host's feature name** — `apps/email`, `apps/secrets`, any registry host — is refused before anything is created.
- The routes a feature stanza gives up are named in the run's output, whether inherited or declared under a tracked `env.feature`. Rate limiters reach a tracked `env.feature` too, not only a stanza the run creates.
- `createSecretIfAbsent` answers `created`, `present` or `unconfirmed` — a create that threw with an entry there afterwards may have been its own, and it no longer says otherwise. An entry Cloudflare lists as `deleted` is not counted as there, and a duplicate name is resolved to the oldest entry rather than trusted to be refused.
- `pithy deploy`'s kit pass reads a feature's ids from the generated config's `env.feature`, not its top level.

The dev login stays `dev`'s alone: no route, no seed and no link on a feature, where a magic link is how anybody signs in. A feature's seed is refused a secret, as `staging` and `prod` are, and never opens the dev secrets file.

`pithy seed` hands a prepared set its Worker's own origin off `dev` as well: a declared environment's declared address, and a feature's `workers.dev` origin, looked up once a run. `--host <host>` overrides it in any environment. A bare host takes the environment's scheme, and one rule decides what a host is: every label a DNS label, nothing after the host, off `dev` no port and no `http`, and read as `new URL` reads it — a host it refuses is refused, and a spelling it rewrites is refused, so `127.1`, `0x7f.0.0.1` and `0.0.0.0` are the loopback they are. Loopback in any spelling, IPv6 included, is `dev`'s alone, and no IP address is a deployed Worker's origin.
