---
"@pithy-sh/core": patch
"@pithy-sh/vite": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

A Worker launched by a custom `dev.command` is told its own origin too.

The first half of #462 handed a Worker its allocated origin as `--var BASE_URL` on the `wrangler dev` argv. That misses every UI-bearing Pithy app, which is most of them: they run through a custom `dev.command` — a Vite dev server, not wrangler — where there is no argv to append to. The Worker that motivated the issue was one of them, so the first half fixed the four workers that were already fine and not the one that was broken.

`@cloudflare/vite-plugin` takes a Worker's `vars` from `wrangler.jsonc` and offers exactly one way in: the `config` customizer. So the value travels in that child's **environment** — `PITHY_WORKER_ORIGIN`, declared in `@pithy-sh/core`'s `worker/identity.ts` beside `ENVIRONMENT_VAR`, because `pithy dev` writes it and `@pithy-sh/vite` reads it and those two packages cannot import each other — and `devWorkerConfig()` turns it into the binding:

```ts
cloudflare({ config: devWorkerConfig() })
```

`pithy init` scaffolds that line. An existing project adds it once; there is no way around that, because the customizer lives in the adopter's `vite.config.ts` and nothing else can reach the Worker's vars.

**Two carriers, one value.** `ownOriginFor` is what both the argv path and the environment path read, so they cannot drift — and a capability host is exempt from both by one function rather than by a condition repeated at each. Its `BASE_URL` stays the *app's* origin, because a host holds no public route and a verification link it mails has to arrive back at the app.

**Per child, which is why it could not go in the shared table.** `buildWorkerEnv` is built once for every child: `<STEM>_ORIGIN` is the same table of *other people's* addresses for everybody. "Where do I answer" is the one fact that differs per child, so `childEnvFor` adds it to that child's environment and to no one else's.

Outside `pithy dev` the helper contributes nothing and the declared value stands — which is what a deployed environment wants, since `applyDomains` generated it from `domains`. It never invents an origin; it only passes on one that was allocated.

Verified end to end against `pithy-sh/dashboard` in a checkout allocated block index 2: the seed registered the self-connection at `http://localhost:8827`, the Worker minted `iss: http://localhost:8827`, and `GET /control-plane/manifest` answered **200** with the composed capability list. Before this it answered 401.
