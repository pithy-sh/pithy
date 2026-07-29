---
"@pithy-sh/cli": minor
---

Ship the six missing standard commands from `docs/CLI.md` §1.1: `worker`, `dev`, `env`, `upgrade`, `alias`, and `doctor`.

- `pithy worker add|list|remove` — manage the project's Workers under `apps/<name>/`, each with a co-located `pithy.worker.jsonc` manifest (a file you own; `wrangler.jsonc` stays wrangler's). Discovery keys on the manifest, so a non-Worker process (a Vite frontend) can join the dev set. Adding a worker reconciles the feature's pinned ports without moving any existing worker.
- `pithy dev` — the multi-worker local orchestrator. Verifies each worker's pinned port on both `127.0.0.1` and `::1` and reports a conflict rather than drifting, labels and tees output to `logs/dev.log`, wires workers to each other over localhost (`*_ORIGIN`), and tears down the whole process subtree cleanly.
- `pithy upgrade` — reconcile installed, non-ejected capabilities with their current manifests: add missing bindings to `wrangler.jsonc` per environment and missing options to `pithy.config.ts`, never rewriting an adopter-changed value. `--dry-run`, `--migrate`.
- `pithy doctor` — toolchain state, an update check, and (inside a project) config/binding/migration health that exits non-zero on drift so CI can gate on it. Ships the update notifier: 24-hour cache, per-installer upgrade command, and three opt-out paths.
- `pithy alias` — install/remove the `p.` shortcut across bash, zsh, fish, PowerShell, and nushell, idempotently and marker-wrapped.
- `pithy env` — a read-only inventory of every environment's bindings, resolved ids, provisioned state, and dashboard deep links.

All six are non-interactive with `--json`.

**One `pithy.config.ts` per Worker.** `apps/<name>/` is now the only place a Worker lives — there is no root Worker. Each Worker owns its `pithy.config.ts` (`{ capabilities, app }`), `wrangler.jsonc`, and `pithy.worker.jsonc`, because everything capabilities drive is per-Worker: the composed route tree, the bindings written into that Worker's wrangler config, and Durable Object class migrations, which register a class against a specific script. The root `pithy.config.ts` keeps only what cannot be per-Worker — `name`, `tokens`, and `seed.productionEnvironments`.

- `add` and `remove` take `--worker <name>`; with one Worker it is optional, with several the CLI prompts at a terminal and fails with an actionable error under `--json` rather than guessing.
- `migrate`, `seed`, `upgrade`, `doctor`, and `env` fan out over every Worker and accept `--worker` to narrow.
- Workers share a resource by declaring the **same binding name** — feature resource names carry no Worker segment, so two Workers that both declare `DB` are backed by one D1, and Workers sharing a database migrate it once. Locally, `dev`, `migrate`, and `seed` persist Miniflare state at the project root so a shared database is genuinely shared.
