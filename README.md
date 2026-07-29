<p align="center">
  <img src="docs/assets/brand/pithy-wordmark.svg" alt="pithy." width="180">
</p>

<p align="center">A backend kit. For Cloudflare. That's it.</p>

---

Pithy is an open-source, Cloudflare-native backend kit for mobile and web apps. Auth, storage, vector, leaderboard, jobs — composable capability packages under `@pithy-sh/*`, wired by a `pithy` CLI. You own the Worker, the account, the data. No data plane we operate.

The logic lives in the packages and upgrades with them. The only surface you own is thin: `pithy.config.ts`, `wrangler.jsonc`, a mount file.

## Quickstart

From an empty directory to a deployable Worker.

```sh
mkdir my-backend && cd my-backend

pithy init            # scaffold the Worker, config, and per-env wrangler.jsonc
bun install           # pull @pithy-sh/core and hono

bun run dev           # wrangler dev — boots the Worker locally
curl localhost:8787/health
# {"status":"ok"}

pithy migrate         # run the migration registry (empty until you add a capability)
```

That's Phase 0: `pithy init` takes an empty directory to a Worker that boots, validates its per-environment config, runs migrations, and serves `GET /health`. The scaffold ships `dev`, `staging`, and `production` config paths from the start.

## What you get

- **`pithy.config.ts`** — the entire user-owned surface. Your app is a capability like any other: routes, middleware, databases, KV namespaces, and the bindings they need.
- **A Worker that boots.** `createBackend(config)` assembles your capabilities into one Hono app — typed `db`/`kv` registries on every request, fail-fast binding validation, and `GET /health`.
- **`pithy migrate`.** One ordered, per-database migration registry, run against an `--env` (`--rollback` to step back). Kysely migrations with tested rollbacks — not raw SQL, not wrangler's D1 migrations.
- **`pithy ui add react`.** A React 19 front end scaffolded into a Worker you already have, on the same origin as its API. One dev server, one build, one deploy. See [`docs/UI.md`](docs/UI.md).

Every command is agent-drivable: full flags, no required prompt, `--json` everywhere. Humans and agents drive the same CLI.

## Status

Phase 0 — the foundation. `init`, the Worker contract, the migration runner, and `migrate` are in. Capabilities (`pithy add auth`, storage, vector, leaderboard, jobs) and remote `migrate`/`deploy` land in Phase 1+.

## Docs

- [`docs/CLI.md`](docs/CLI.md) — command behavior, flags, output.
- [`docs/UI.md`](docs/UI.md) — front ends: `pithy ui`, the React stub, one origin.
- [`docs/STACK.md`](docs/STACK.md) — the toolchain.
- [`docs/BRAND.md`](docs/BRAND.md) — identity and voice.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to work in this repo.

## License

MIT. See [`LICENSE`](LICENSE).
