---
"@pithy-sh/cli": patch
"@pithy-sh/vite": patch
---

A deploy to a named environment publishes that environment.

`pithy deploy --env staging` shipped a Worker composed as `dev`, publicly, and reported success. Two
mechanisms met. The front end's build was handed `ENVIRONMENT`, which `@cloudflare/vite-plugin` does not
read to select a wrangler environment — it reads **`CLOUDFLARE_ENV`** — so every build emitted the
top-level stanza. And `vite build` writes `.wrangler/deploy/config.json`, which redirects the following
`wrangler deploy` to that flattened output, where `--env staging` matched nothing and was silently
ignored. The Worker that landed carried dev bindings, dev vars, no routes, and `workers.dev` open, with
`registerDevLoginRoute` mounted on it.

The build is now told both names, because they are two variables with two jobs. A feature environment is
told a third, `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, so the build reads the generated config its ids
live in — which is what lets the feature path stop passing `--config` for a Worker with a front end. That
branch was broken in the opposite direction: an explicit `--config` beats the redirect, and the source
config carries no `assets.directory` because only the build writes one, so a feature deploy of a UI
Worker failed on exactly that, every time.

**The gate is the point, and it is not "`CLOUDFLARE_ENV` is set".** After the build and before the
upload, deploy resolves the configuration wrangler will actually read — an explicit `--config`, else the
redirect, else the Worker's own `wrangler.jsonc` — and holds it to what the project declares for the
environment that was asked for: the script name, and `vars.ENVIRONMENT`. They disagree and that Worker is
not deployed, naming the file it was about to ship. The class has now produced two mechanisms in one
command, so the invariant is stated about the file that ships rather than about either of them.

`--env dev` no longer passes `--env` to wrangler or `CLOUDFLARE_ENV` to the build: `dev` is the top-level
stanza, and `DeclaredEnvironments` forbids a project from writing an `env.dev` for wrangler to find.

A probe that cannot reach the declared origin now reads as a failure — `deployed, and not verified.` —
rather than as an indented note under a `deployed.` line. It already failed the command; it did not say
so, and an operator was told to check a route while the wrong Worker sat on a public URL.

`@pithy-sh/vite` also resolves its environment from `CLOUDFLARE_ENV` when `ENVIRONMENT` is unset, so a
hand-run or CI `CLOUDFLARE_ENV=staging vite build` no longer inlines dev projections beside staging's
Worker config.

**The gate reads both of wrangler's inputs, not just the argv.** wrangler resolves the environment as
`args.env ?? CLOUDFLARE_ENV`, so an operator with `CLOUDFLARE_ENV=prod` exported in their shell who runs
a bare `pithy deploy` publishes the **prod** stanza — and a gate reading the argv alone expects the
top-level one and approves it, blessing exactly the class of mistake it exists to refuse. The same two
inputs are read here now, in the same precedence, and a refusal names the variable when the variable is
what selected the stanza, because an operator told to rebuild would never find it.

**A scaffolded Worker's deploy scripts name the Worker's own configuration.** `vite build` leaves a
`.wrangler/deploy/config.json` redirect, and wrangler searches for it upwards — so
`bun run build && bun run deploy:staging` reproduced this defect in a script the kit wrote, and a Worker
with no front end could be redirected by a sibling's build higher in the tree. `wrangler deploy --config
wrangler.jsonc --env <name>` deploys the tracked file or nothing. Once a Worker has a front end those
scripts fail rather than ship, because the tracked `assets` stanza carries no `directory` — that Worker
is `pithy deploy`'s to ship, which builds what it deploys and holds the result to the environment asked
for.
