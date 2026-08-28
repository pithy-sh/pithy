---
"@pithy-sh/cli": patch
---

A Worker started by `pithy dev` is told where it itself answers.

`pithy dev` allocates a port block per checkout and pinned the result in `.dev.config.json`, then published every worker's origin to that worker's **siblings** as `<STEM>_ORIGIN` — and never to the worker itself. So the one address a Worker cannot work out had to be written down: `Host` is caller-controlled, so deriving it from a request takes your identity from whoever called you, and a `vars.BASE_URL` in `wrangler.jsonc` is right in the first checkout on a machine and wrong in every other one.

Every wrangler-launched Worker now gets `--var BASE_URL:<its own allocated origin>`, read verbatim from `.dev.config.json` rather than rebuilt from the port. A `--var` beats a config `vars` entry, so a project that already wrote a dev `BASE_URL` down is corrected rather than asked to edit anything. Deployed environments are untouched — `applyDomains` still generates theirs from the `domains` declaration, and nothing here runs outside `dev`.

**What it cost to not have.** `pithy-sh/dashboard#95`. That Worker composes `controlplane`, where `BASE_URL` is the `iss` on every token it signs. A second checkout seeded its self-connection at `http://localhost:8807` — correctly, via `SeedPrepareContext.origin` (#458) — and then signed `iss: http://localhost:8787`, because that is what the file said. `POST /api/control-plane/token` answered 200, `GET /control-plane/manifest` answered 401, and every value that could be inspected in D1 agreed with itself, because the one that disagreed was on the token. The dashboard's rail silently dropped every kind that needs a manifest, which reads as a broken product rather than a misconfigured checkout. This is #458 one layer out: the seed could ask, and the Worker registering it still could not.

**A capability host is handed nothing, and that is the interesting case.** A host's `BASE_URL` is the *app's* origin, not its own — it holds no public route, and a verification link it mails has to arrive back at the app. `materializeHostConfigs` already writes that into the host's generated config, so overriding it here would have pointed every callback at the mailer. `<STEM>_ORIGIN` and `BASE_URL` sit two functions apart, look alike, and mean opposite things: one is somewhere to send a request, the other is who you are. Both now say so.
