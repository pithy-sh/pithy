---
"@pithy-sh/core": patch
"@pithy-sh/cli": minor
"@pithy-sh/email": patch
"@pithy-sh/secrets": patch
"@pithy-sh/cloudflare": patch
---

A feature deployment has an address. A feature Worker answers on `https://<script>.<subdomain>.workers.dev`, and `pithy provision --feature` now derives that from the Worker's script name and the account's `workers.dev` subdomain, through the same resolver staging and prod use, and stamps it as the feature stanza's `vars.BASE_URL`. `originFor` reads that stamp inside a feature deployment, so the scaffolded `PUBLIC_ORIGIN` — and with it auth's base URL, email's links and payments' return URLs — is the feature's own origin instead of `http://localhost`. Only a `workers.dev` https origin is read, so a `BASE_URL` a feature inherits from the top level is never taken for its own. A declared environment never falls back to `workers.dev`. `pithy dashboard connect --env feature` registers the same address.

A feature answers on that address and nothing else. Its generated stanza states `routes: []`, because wrangler inherits a top-level `routes` into every environment that sets none: a branch deploy took the project's custom domain, and with routes and no `workers_dev` it got no `workers.dev` address at all. A top-level `workers_dev: false`, which wrangler also inherits, means no address. `pithy deploy --env feature` verifies against the feature's own origin, read from the generated config.

A feature deployment sends a magic link, and the link signs the person in.

- `pithy provision --feature` creates the feature's own master key and seals every arbitrary `d1` secret — `auth-session-secret` among them — into the feature's own `SECRETS` database, where the Worker reads it. The feature's own stores are the only copy; nothing is kept on the machine that ran it. A run from any machine creates only what is absent and never overwrites: the master key through the Secrets Store's create-if-absent, rows through an insert that leaves one already there alone, so two runs at once leave one value. A read that fails fails the run. A master key that exists beside a missing `d1` secret cannot be sealed under, so after waiting for any concurrent run the command refuses by name and says how to start the feature's secrets over.
- Each feature gets its own email host, `<project>-f<issue>-<slug>-email`, with Workflows named the same way, bound to the feature's own databases and keys. `pithy provision --feature` deploys it through the same resolver and gated deploy `pithy deploy` ships a declared environment's with, and binds the app Worker's `EMAIL_SENDER` to it. `pithy deploy --env feature` redeploys it when it changes and skips, by name, any kit Worker a feature does not host yet. `pithy feature destroy` deletes it.
- A new `env.<name>` stanza carries the top level's rate limiters whole — a limiter's `namespace_id` is the same in every environment — so a feature binds `AUTH_RATE_LIMITER`.
- `pithy deploy`'s kit pass reads a feature's ids from the generated config's `env.feature`, not its top level.

The dev login stays `dev`'s alone: no route, no seed and no link on a feature, where a magic link is how anybody signs in. A feature's seed is refused a secret, as `staging` and `prod` are, and never opens the dev secrets file.

`pithy seed` hands a prepared set its Worker's own origin off `dev` as well: a declared environment's declared address, and a feature's `workers.dev` origin, looked up once a run. `--host <host>` overrides it in any environment. A bare host takes the environment's scheme, and one rule decides what a host is: every label a DNS label, nothing after the host, off `dev` no port and no `http`, and read as `new URL` reads it — a host it refuses is refused, and a spelling it rewrites is refused, so `127.1`, `0x7f.0.0.1` and `0.0.0.0` are the loopback they are. Loopback in any spelling, IPv6 included, is `dev`'s alone, and no IP address is a deployed Worker's origin.
