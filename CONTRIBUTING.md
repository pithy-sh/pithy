# Contributing to Pithy

How we work. GitHub is the source of truth — issues hold the specs, and the **Pithy** Projects board tracks where each idea sits. Two skills drive it: `/refine` shapes ideas into `Ready` issues; `/ship` builds and ships them.

## Capturing and refining work

Use `/refine`. It interviews you one question at a time, writes a structured GitHub issue, and moves it across the board.

| Command | Does |
|---------|------|
| `/refine` | Browse the board. Pick an idea to refine, or capture a new one. |
| `/refine #N` | Refine issue `N`. Re-run anytime to continue. |

The skill owns the mechanics — issue template, board ops, the lot. See [`.claude/skills/refine/SKILL.md`](.claude/skills/refine/SKILL.md).

## Building work

Use `/ship`. It takes a `Ready` issue and carries it to a merged PR — TDD implementation, the real gates (`typecheck` / `biome` / `vitest`), `/code-review` and `/security-review`, a PR that closes the issue, and a Changesets release note. It stops at two gates for your approval.

| Command | Does |
|---------|------|
| `/ship #N` | Build issue `N`. |
| `/ship` | Build the lowest-numbered `Ready` issue whose dependencies are `Done`. |

Mechanics live in [`.claude/skills/ship/SKILL.md`](.claude/skills/ship/SKILL.md).

## The board

The [Pithy board](https://github.com/orgs/pithy-sh/projects/1) tracks each issue's **Stage** across its life:

`Inbox → Refining → Ready` (owned by `/refine`) `→ Building → In review → Done` (owned by `/ship`).

## Setup

`gh` needs the Projects scope (read+write), one time:

```bash
gh auth refresh -s project
```

## Live integration tests

Most tests run locally (node + Miniflare). A few exercise live Cloudflare, are excluded from the default suite, and are named `*.integration.test.ts` — run with `bun run --filter <package> test:integration`. They are required before a release.

They read credentials from a gitignored `.dev.vars` at the repo (or worktree) root:

```sh
CLOUDFLARE_ACCOUNT_ID=<account id>        # `wrangler whoami`, or the dashboard URL
CLOUDFLARE_API_TOKEN=<account-scoped api token>   # scopes below
SECRETS_STORE_ID=<cf secrets store id>            # used by @pithy-sh/secrets
```

`CLOUDFLARE_API_TOKEN` is one account-scoped token covering every package's live tests, so a failing integration test that returns 403/authz is almost always a missing scope here. The permissions it carries (all account-level):

- **D1** — Read, Write (create/delete/query databases)
- **Secrets Store** — Read, Write (the secrets at-rest key write-back)
- **Workers Scripts** — Read, Write (deploy workers; Cloudflare Workflows have no separate permission — they deploy with their Worker, so this also covers Workflow dispatch)
- **Workers KV Storage** — Read, Write
- **Workers R2 Storage** — Read, Write
- **Workers AI** — Read, Write
- **Workers Tail** — Read
- **Vectorize** — Read, Write
- **Queues** — Read, Write
- **Images** — Read, Write
- **Stream** — Read, Write
- **Turnstile Sites** — Read, Write
- **Email Sending** — Read, Write

The creds also work as plain environment variables (CI passes them from GitHub Actions secrets): each loader falls back to `process.env` when no `.dev.vars` file is present. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are wrangler's own env-var names, so the `wrangler deploy` step authenticates from them directly — no separate `wrangler login`.

One live test actually deploys Workers: the secrets provision → write/rotate/audit → teardown round trip (`secretsProvisioner.integration.test.ts`). It provisions both managers, writes a secret through the write Workflow (with an in-worker `audit` that decrypts and confirms the round trip — only a boolean leaves the worker, never the value), triggers the at-rest rotation Workflow and checks the stored `key_version` advances, then deletes everything. It deploys the real-named `pithy-secrets-<env>` managers and then deletes them, so it is double-gated — it needs the creds above **and** `PITHY_LIVE_DEPLOY=1`. Run it deliberately (`PITHY_LIVE_DEPLOY=1 bun run --filter @pithy-sh/cli test:integration`), never against an account whose managers you want to keep.

That deploy needs one account-level prerequisite: a registered **`workers.dev` subdomain** (Cloudflare requires one to deploy Workers that host Workflows). It is a one-time account bootstrap — open Workers & Pages in the dashboard once and Cloudflare creates it automatically. Provisioning preflights this and fails with a clear message if it is missing, so a fresh CI account must be bootstrapped once before the deploy test can run.

## Voice

Everything user-facing — issues, comments, commits, board copy — follows [`docs/BRAND.md`](docs/BRAND.md). Short sentences. Deliberate periods. No fluff.
