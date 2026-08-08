# Shipping: migrate and deploy

Two commands take a project from local to live: `pithy migrate` promotes your schema, `pithy deploy` ships your Workers. Both run by hand and headless in CI. Both are idempotent and target one `--env`. They stay orthogonal — deploy never migrates.

## Environments

Config resolves per environment: **dev** (local), **staging** (test users), **production** (paid users). `dev` is the top-level `wrangler.jsonc`; `staging` and `production` are its `env.<name>` blocks. Each block declares that environment's D1 bindings and their remote `database_id`.

## Credentials

Out-of-Worker commands read wrangler's own env vars: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Locally they live in `<config>/cloudflare.json` — account-scoped, mode `0600`, outside every checkout, written by `pithy init`. In CI, pass them as environment variables — GitHub Actions secrets, no config file, no interactive `wrangler login`. The bootstrap token works; a least-privilege `<project>-<env>-ci-system` token minted by `pithy token mint` is what CI should run under. See [`TOKENS.md`](TOKENS.md).

## Migrate

`pithy migrate --env <env>` runs the project's migration registry against that environment's D1. The registry, ordering, and per-database runs are identical everywhere — only the driver differs: `dev` runs locally through Miniflare under `.wrangler/state` (the store `wrangler dev` reads), while `staging` and `production` execute over the D1 REST API against the remote database.

Run it by hand:

```bash
pithy migrate --env staging
pithy migrate --env production
```

Roll the latest migration back with `--rollback`:

```bash
pithy migrate --env staging --rollback
```

Every run is idempotent — a second run with nothing pending is a no-op. `--json` emits a per-database summary, carrying the project it ran as; a failure exits non-zero.

### The database has an owner

`pithy migrate` records the project in a `pithy_migrations_owner` row beside the migration ledger, and **refuses a database another project owns.** Every database in the run is claimed before any of them is written to, so a foreign one aborts the run rather than being found halfway through.

Every command that can change a database passes the same claim, not just `migrate`: `pithy add`, `pithy remove --drop`, `pithy upgrade --migrate`, `pithy seed --redo`, and each of the `pithy feature` steps that migrates. They share one code path, and it refuses to run at all without a project name — so a command cannot write to a database without saying who it is writing as.

This is the counterpart to project-scoped naming ([`NAMING.md`](NAMING.md)): the name keeps two projects from provisioning onto each other, and the stamp keeps a hand-edited binding from pointing one project's migration registry at another's data. An unstamped database is adopted on first migrate; your own is a no-op.

Migrate therefore needs `name` in the root `pithy.config.ts` and will not guess one. A guessed name would stamp one value and check a different one on the next run, locking a project out of its own database. Nothing clears the stamp — deliberately handing a database to another project means dropping that table by hand.

### As a CI promote step

Migrate is the promote step in a merge-to-`main` pipeline. It needs only the two CF env vars:

```yaml
- name: Promote schema
  run: pithy migrate --env production --json
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

The remote `database_id` comes from the target env's `wrangler.jsonc` block; the command resolves it — you pass no ids.

## Deploy

`pithy deploy [--env <env>]` ships your Workers to Cloudflare. It discovers the worker set and runs `wrangler deploy` per worker; wrangler owns bundling, upload, bindings, and routes.

**How the worker set is discovered.** `apps/` is the registry: every `apps/<name>/` holding a `wrangler.jsonc` is one deployable Worker, and deploy ships them all. A project that has not adopted the `apps/` layout yet — the current `pithy init` scaffold is a single Worker with `wrangler.jsonc` at the root — has no `apps/`, so deploy **falls back to that root worker**. Either way you deploy the whole set with one command; there is no hand-maintained list.

```bash
pithy deploy --env production
```

Output is labeled per worker. `--json` returns a per-worker summary (name, version id, url). Any worker's failure yields a non-zero exit; the others still deploy.

**Capability host Workers are not part of this set.** The prebuilt Workers that host a capability's Workflows are named `<project>-<env>-<capability>` and deployed by that capability's own `provision` command ([`NAMING.md`](NAMING.md)). `pithy deploy` ships the Workers you wrote, under the `name` in their own `wrangler.jsonc`.

Deploy reads the same two CF env vars, so CI needs no interactive login:

```yaml
- name: Deploy workers
  run: pithy deploy --env production --json
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Order: migrate, then deploy

Migrate and deploy are separate, gated steps — sequence them `migrate --env` then `deploy --env`. Deploy does not auto-migrate. It will *warn* when the target environment's schema is behind, but it never blocks or runs migrations for you. Promote the schema first, then ship the code.
