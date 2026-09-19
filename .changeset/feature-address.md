---
"@pithy-sh/core": patch
"@pithy-sh/cli": minor
"@pithy-sh/auth": patch
---

A feature deployment has an address. A feature Worker answers on `https://<script>.<subdomain>.workers.dev`, and `pithy provision --feature` now derives that from the Worker's script name and the account's `workers.dev` subdomain, through the same resolver staging and prod use, and stamps it as the feature stanza's `vars.BASE_URL`. `originFor` reads that stamp inside a feature deployment, so the scaffolded `PUBLIC_ORIGIN` — and with it auth's base URL, email's links and payments' return URLs — is the feature's own origin instead of `http://localhost`. Only a `workers.dev` https origin is read, so a `BASE_URL` a feature inherits from the top level is never taken for its own. A declared domain or route still wins, and a declared environment never falls back to `workers.dev`. `pithy dashboard connect --env feature` registers the same address.

`pithy seed` hands a prepared set its Worker's own origin off `dev` as well: a declared environment's declared address, and a feature's `workers.dev` origin, looked up once a run. `--host <host>` overrides it in any environment; a bare host takes the environment's scheme, and a path or another scheme is refused before anything is written.

A feature deployment signs people in. `pithy provision --feature` generates the feature's own secrets once and keeps them: the master key and every arbitrary Secrets Store secret as the feature's own store entries, and every arbitrary `d1` secret — `auth-session-secret` among them — sealed into the feature's own `SECRETS` database, where the Worker reads it. Magic link and OTP no longer answer `secrets/not_found` on a feature. The values are kept in `<config>/<project>/features/f<issue>-<slug>.secrets.jsonc`, mode 600, so a re-run changes nothing and `pithy seed --env feature` signs with the value the Worker checks. When that file is gone, the run generates them again and says so on stderr and as `featureSecrets.regenerated`. `pithy feature destroy` removes the file. The dev secrets file is never opened for a feature, and `staging` and `prod` still refuse, unchanged.

The dev-login route mounts on `dev` and `feature`, never on `staging` or `prod`, and on a feature it sets the `__Secure-` session cookie Better Auth reads over https. Auth's `dev-session` set runs on a feature, records the origin it was minted for in `logs/dev-login.feature.json`, and `pithy seed --env feature` prints the link to open. Auth's example cast seeds on a feature too, so the dev login has someone to sign in as.

`--host` takes a host by one rule: every label a DNS label, so `%2e%2e` is refused; nothing after the host, so a path, a query, a fragment and a trailing `/` are refused rather than normalized away; off `dev`, no port and no `http`, as `featureOrigin` refuses for the same deployment. `localhost` is `dev`'s alone. `featureOrigin` refuses a stamp whose hostname has a malformed label.

A top-level `workers_dev: false`, which wrangler inherits, now means a feature has no `workers.dev` address. `pithy deploy --env feature` verifies the deploy against the feature's own origin, read from the generated config.
