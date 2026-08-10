---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

The asset allowlist is derived from every environment's route table, not one

`pithy dev` printed a sign-in URL that landed on the front end's 404. `/__pithy/dev-login` was not in
`assets.run_worker_first`, so Cloudflare's asset router answered it with the SPA shell and the Worker never
ran. `pithy ui sync --check` reported `every route reaches the worker` the whole time.

Both halves were doing their job. `@pithy-sh/auth` mounts that route only in a `dev` composition with `CI`
unset, because it mints an authenticated session with no credential presented — its absence from a shipped
route table is the security property. And `pithy ui sync` derived the allowlist by composing the Worker once,
under whatever environment the command happened to run in. That is not a `dev` composition, so the route did
not exist to be found.

**A Worker has one route table per environment.** The derivation now assembles it once per environment the
project declares plus `dev`, and takes the union. Any conditionally-mounted route is covered without being
named — gated on the environment, on a flag, on a capability being composed — so this closes the class rather
than the one path. Reserving the `/__pithy` prefix wholesale would have fixed the symptom and left
`--check`'s claim just as false for the next one.

`CI` is deliberately ignored while deriving. `--check` runs in CI and `sync` runs on a laptop; a list that
differed between them could never be checked. The asymmetry makes it free — an allowlist entry nothing serves
costs a 404 from the Worker, a missing one costs a 200 with the wrong body.

Production is unchanged: the route is still mounted only in `dev`, and still 404s everywhere else.

Run `pithy ui sync` once. It adds `/__pithy` and `/__pithy/*`, and `--check` fails until you do. A project
that added those entries by hand can drop the hand edit — the derivation writes them now.
