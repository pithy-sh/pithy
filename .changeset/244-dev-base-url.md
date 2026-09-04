---
"@pithy-sh/auth": patch
---

`auth.baseURL` gets a dev form, so an HTTPS project has a working dev session.

`baseURL` was one string for every environment a Worker runs in. Production is HTTPS, dev has no TLS, and `pithy add auth` scaffolds `https://api.example.com` — so every project got a dev that was broken twice and said nothing. Better Auth minted `__Secure-better-auth.session_token` from the HTTPS base URL while `pithy seed` wrote the unprefixed name, so `get-session` returned `null` and every session-gated route answered `auth/invalid_token`. And the same-origin gate held `https://api.example.com` against a browser at `http://localhost:8787`, so every mutating cookie route answered `auth/forbidden`. Neither was a mistake the adopter made, and neither logged anything to search for.

`baseURL` still means one thing and it is the deployed origin. A `dev` composition now ignores it and resolves `http://<the host the request arrived at>`. A per-environment record was the obvious shape and fails on the one value it exists to hold: the dev port is assigned per Worker per run, so a written-down `dev` key is wrong the moment a second Worker starts. The request is the only thing that knows the port.

The `__Secure-` assumption stops being a comment. We run no TLS locally, so a dev composition's scheme is a constant; the seed names its cookie from that constant and the instance names its cookie from the base URL resolved off it. The host and port cannot reach the name, which is what lets a seed name a cookie for a port not yet assigned.

The relaxation is one condition on the environment alone, read in one function. Staging and production resolve `baseURL` verbatim, and the origin set the CSRF gate builds there is unchanged — the origin it adds is the one the configured base URL already contributed. Dev is not a wildcard either: a request whose `Origin` is a neighboring worker in the same `pithy dev` run is refused like any other.

Measured against a real `wrangler dev` on a project scaffolded by `pithy init` and `pithy add auth`, at two ports, before and after.
