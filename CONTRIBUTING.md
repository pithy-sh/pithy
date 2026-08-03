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

## Licence headers

Every `.ts` and `.tsx` under `packages/*/src` and `tooling/*/src` carries two lines:

```ts
// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT
```

You do not write them. A commit hook stamps staged files, deriving the identifier from the package's own `license` field — so a file in `@pithy-sh/audit` gets `FSL-1.1-MIT` without you thinking about it. CI checks the whole repo with `bun scripts/license-headers.ts --check`, which also reconciles each package's `LICENSE` file against what its `package.json` declares.

Run it yourself any time:

```bash
bun scripts/license-headers.ts --check   # what's wrong
bun scripts/license-headers.ts --fix     # fix it
```

`tooling/*` packages are stamped too, but are not asked for a `LICENSE` file — they are private and never published, so there is no tarball for one to travel in.

Two things it deliberately leaves alone. The copyright line is free-form — edit it and the gate won't argue, so naming an entity later costs one pass, not a rewrite of every file. And `templates/` trees are never stamped: those files are copied verbatim into the adopter's repo by `pithy init` and `pithy ui add`, where they become the adopter's code, under the adopter's copyright.

## Live integration tests

Most tests run locally (node + Miniflare). A few exercise live Cloudflare, are excluded from the default suite, and are named `*.integration.test.ts` — run with `bun run --filter <package> test:integration`. They are required before a release.

**`pithy-int-` is a reserved namespace.** Every Cloudflare resource a live test creates is named through `uniqueName()` in [`packages/cloudflare/src/test-utils/harness.ts`](packages/cloudflare/src/test-utils/harness.ts), which composes that prefix itself — you pass only the distinguishing part, `uniqueName("kv")`. `pithy init` refuses a project name that would land inside the namespace, so a `pithy-int-` resource is test debris by definition and never an adopter's. That is what lets each suite's `beforeAll` reap on the prefix alone: teardown only runs while the process lives, so a run killed by a Ctrl-C or a timeout orphans whatever it had created, and the next run reclaims it. Anything older than twelve hours goes — two orders of magnitude past any plausible suite, so a slow run is never reaped out from under itself.

Two rules follow, and both have been broken before. **Never name a live resource by hand** — a `pithy-secrets-migrate-test-…` database sat unreapable inside the product's own namespace precisely because it skipped `uniqueName`. And when the resource names are themselves under test (`pithy feature provision`), provision under the reserved project `pithy-int-test` instead: every provisioned name is `<project>-<env>-<thing>` and the project segment comes first and verbatim ([`docs/NAMING.md`](docs/NAMING.md)), so every name it derives lands in the namespace anyway, through the product's own naming path.

**A third rule, from the same family: one credential source must govern the whole run.** A live test that builds a fixture project and hands it to product code has two directories in play, and `loadCloudflareEnv` reads `<dir>/.dev.vars` without walking up — so the fixture resolves `process.env` while the suite's own assertions resolve the package's `.dev.vars`. Where those name different accounts, the run splits: `pithy-int-deploy-…` Workers were uploaded to one account while the existence check and the `DELETE` addressed another, so the assertion 404'd, every teardown was a tolerated 404, and eight live endpoints leaked over four runs. **Give the fixture its own `.dev.vars`, written from the credentials the assertions use** — it pins the run to one account and is the realistic shape besides, since a real project root has one. Then let teardown *prove* the delete: a 404 on a resource the run created is not "already gone", it is "created somewhere else, and still live". Nothing warns you here — a fixture with no `.dev.vars` resolves a complete, coherent pair from the environment, which is exactly how CI runs and is indistinguishable from it. The proving teardown is the guard.

R2 is the one kind that needs more than the API token. Cloudflare refuses to delete a non-empty bucket and emptying one is an S3 operation, so bucket reaping needs `R2_CREDENTIALS`; without it `reapStaleTestBuckets` reclaims nothing and says so.

They read credentials from a gitignored `.dev.vars` at the repo (or worktree) root:

```sh
CLOUDFLARE_ACCOUNT_ID=<account id>        # `wrangler whoami`, or the dashboard URL
CLOUDFLARE_API_TOKEN=<account-scoped api token>   # scopes below
SECRETS_STORE_ID=<cf secrets store id>            # used by @pithy-sh/secrets
R2_CREDENTIALS={"accessKeyId":"…","secretAccessKey":"…"}   # S3 keys; R2 suites skip without them
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

One live test actually deploys Workers: the secrets provision → write/rotate/audit → teardown round trip (`secretsProvisioner.integration.test.ts`). It provisions both managers, writes a secret through the write Workflow (with an in-worker `audit` that decrypts and confirms the round trip — only a boolean leaves the worker, never the value), triggers the at-rest rotation Workflow and checks the stored `key_version` advances, then deletes everything. It runs under the reserved project `pithy-int-test`, so **every** name it touches — the manager Workers and their D1s, both Workflows, the Secrets Store entries, the CF API token it mints — is `pithy-int-test-…`, and teardown recomputes exactly those, never a real project's. It is still double-gated — it needs the creds above **and** `PITHY_LIVE_DEPLOY=1` — because it really does deploy Workers, run Workflows, and write to the account's one Secrets Store. Run it deliberately (`PITHY_LIVE_DEPLOY=1 bun run --filter @pithy-sh/cli test:integration`).

That deploy needs one account-level prerequisite: a registered **`workers.dev` subdomain** (Cloudflare requires one to deploy Workers that host Workflows). It is a one-time account bootstrap — open Workers & Pages in the dashboard once and Cloudflare creates it automatically. Provisioning preflights this and fails with a clear message if it is missing, so a fresh CI account must be bootstrapped once before the deploy test can run.

## Voice

Everything user-facing — issues, comments, commits, board copy — follows [`docs/BRAND.md`](docs/BRAND.md). Short sentences. Deliberate periods. No fluff.
