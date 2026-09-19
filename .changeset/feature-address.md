---
"@pithy-sh/core": patch
"@pithy-sh/cli": minor
"@pithy-sh/auth": patch
---

A feature deployment has an address. A feature Worker answers on `https://<script>.<subdomain>.workers.dev`, and `pithy provision --feature` now derives that from the Worker's script name and the account's `workers.dev` subdomain, through the same resolver staging and prod use, and stamps it as the feature stanza's `vars.BASE_URL`. `originFor` reads that stamp inside a feature deployment, so the scaffolded `PUBLIC_ORIGIN` — and with it auth's base URL, email's links and payments' return URLs — is the feature's own origin instead of `http://localhost`. Only a `workers.dev` https origin is read, so a `BASE_URL` a feature inherits from the top level is never taken for its own. A declared domain or route still wins, and a declared environment never falls back to `workers.dev`. `pithy dashboard connect --env feature` registers the same address.

`pithy seed` hands a prepared set its Worker's own origin off `dev` as well: a declared environment's declared address, and a feature's `workers.dev` origin, looked up once a run. `--host <host>` overrides it in any environment; a bare host takes the environment's scheme, and a path or another scheme is refused before anything is written.

A feature's seed secrets are generated for the run: a secret whose registry entry declares a `devValue` gets one value per name, and any other is absent. The dev secrets file is never opened for a feature, and `staging` and `prod` still refuse, unchanged. Auth's `dev-session` set now runs on a feature, and writes its login as `logs/dev-login.feature.json`, so seeding a feature never overwrites the local login `pithy dev` reads.
