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

## Migrations

**Until the first publish, a capability's schema is one migration per database.** Not a chain — one file, holding the whole shape, with one tested `down`.

**The condition is the whole rule, so read it before copying the shape.** Nothing in this repository has ever been published. Every package sits at `0.0.0`, `npm view @pithy-sh/core version` is a 404, and the only adopter is `pithy-sh/dashboard`, whose dev database is recreated in two minutes. A migration chain buys exactly one thing: the ability to walk a database that already holds rows from an old shape to a new one. There is no such database, so a `0002` today is a step from a shape that never ran to a shape that never shipped — two `down`s, two test suites, and a history nobody will replay. Git already records when each column arrived, which is the only thing a chain actually preserves. Three capabilities had drifted into one anyway (#276).

**After the first publish, the chain is append-only.** A migration that has run somewhere real is history, and history is not edited. From that day a schema change is a new migration, always, and folding one into `0001` would silently re-shape a database somebody is already running. Nothing about a tidy `0001` tells you which side of that line you are on — so check the condition, do not infer it from the file.

`packages/cli/src/migrations/oneMigration.test.ts` enforces the rule while it holds and goes quiet on its own the day a version is cut. It states the invariant twice over: every authored migration is numbered `0001` (the number orders a migration *within its database*, so a `0002` is by definition a second step against one that already has a first), and a package authors no more migrations than the databases it declares a `<NAME>_MIGRATION_ORDER` for.

**Two `0001`s can be right.** `@pithy-sh/email` ships `0001_init.ts` **and** `0001_suppressions.ts`, and folding those together would be a defect: they target different databases. `0001_init` creates the send log in the app `DB`; `0001_suppressions` creates the suppression list in `EMAIL_SUPPRESSIONS`, a separate, durable D1 shared by every environment, because an address that hard-bounced must never be emailed from *any* environment. The capability declares both under `databases`, each with its own binding, its own migration order, and its own migration. Two databases, one migration each — the rule, not an exception to it.

**Generated migrations are outside the rule.** `@pithy-sh/auth`'s `pluginTables.ts` and `@pithy-sh/media`'s `extend.ts` synthesise a migration per adopter, from the plugins or extension schema *that adopter* composes. They are not this repository's schema, no author edits them, and they have no numbered file.

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

## Tests do not touch your machine

**No test in this repository resolves your real config directory or your real Cloudflare account.** Two defects in two weeks were the same defect, and it is worth knowing what the guards are before you write a config.

One `bun run test` used to leave 36 directories in a maintainer's `~/.config/pithy`, each holding a genuinely minted AES master key, and write `SECRETS_STORE_ID` into their real `cloudflare.json` (#200). Separately, every unit suite that resolved a credential was talking to a live account, because `cloudflareEnv` overlays `process.env` per key — correct, and CI depends on it — and anyone who has run `pithy deploy` has a token exported (#198).

Three things now stand in the way, and you get all three by writing a config the way the others are written:

1. **[`vitest.setup.ts`](vitest.setup.ts) at the repo root** gives every test file its own throwaway `PITHY_CONFIG_DIR`. Every project loads it, unit and integration alike.
2. **[`vitest.shared.ts`](vitest.shared.ts) exports `NO_ACCOUNT`**, every `CLOUDFLARE_ENV_KEYS` name blanked, and `PITHY_OFFLINE` pinned blank beside them. Every unit project states it; an integration project must not, because reaching a real account is what it is for.
3. **`stateDir` refuses.** Under vitest it resolves `PITHY_CONFIG_DIR`, or seams you passed — never `process.env` and never `os.homedir()`. A test that forgets its seam fails loudly at the moment of the mistake instead of quietly writing to your home directory.

A new package's config:

```ts
import { defineConfig } from "vitest/config";
import { CONFIG_DIR_SETUP, NO_ACCOUNT } from "../../vitest.shared";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          env: { ...NO_ACCOUNT },
          setupFiles: [CONFIG_DIR_SETUP],
        },
      },
    ],
  },
});
```

**Both lines go on the project, not on the root `test` block.** Measured on vitest 4.1.9: a root `env` reaches an inline project and a root `setupFiles` does not. Stating them at the wrong level is a guard that never runs.

`*.workers.test.ts` projects state neither, deliberately. workerd does not inherit the host environment — a test there sees seven `process.env` keys, all miniflare bindings, no token and no `HOME` — so there is nothing to blank and nothing to relocate.

[`packages/cli/src/ci/testIsolation.test.ts`](packages/cli/src/ci/testIsolation.test.ts) is the gate. It **loads** each config and inspects the object vitest is handed, rather than reading the source, because #198's first guard was a second `env:` key on one object literal — which JavaScript discards without a word, so the file said covered and the run was not. A guard that is present but inert fails there exactly like a missing one.

**A suite that genuinely needs your real config directory** sets `PITHY_ALLOW_REAL_CONFIG_DIR=1`. Nothing in this repository does, and the gate fails if a vitest config ever sets it: that is a decision for one suite to make out loud, not one a config makes for a whole package.

**Cleaning up a machine that ran the suite before this landed.** Everything the old runs left is named after a scaffolded test project, so it is safe to identify by name:

```bash
ls ~/.config/pithy                       # look first — your own projects live here too
rm -rf ~/.config/pithy/bootstrap-*  ~/.config/pithy/turnstile-*
rm -rf ~/.config/pithy/flow-test ~/.config/pithy/gates ~/.config/pithy/acme
```

Then open `~/.config/pithy/cloudflare.json`. If it holds a `SECRETS_STORE_ID` you did not put there, a test wrote it — remove that key. Leave anything you recognise as a real project of yours.

## Running the CLI without reaching an account

`PITHY_CONFIG_DIR` moves the credentials *file*. It never touched the `process.env` overlay, so `pithy doctor` in an empty scratch directory still reached a real account off a token your shell exported hours ago. `PITHY_OFFLINE=1` is the word that stops it (#218): no ambient credentials, no network call, in that process and in anything it spawns.

```bash
export PITHY_CONFIG_DIR="$(mktemp -d)"
export PITHY_OFFLINE=1
```

Set both, leave them set, and work in a sandbox without thinking about it.

**It cannot change a test result.** The unit configs pin `PITHY_OFFLINE` blank exactly as they blank the credential keys, so a unit run answers about the code and not about your shell. That is new: it did not, and five green tests went red for the first person who took this advice, which read as breakage in the code and was not (#227). A suite that wants the offline path sets it itself, in the test, where you can see it.

A live `test:integration` run is the one thing offline does stop. Reaching a real account is what those are for.

## Live integration tests

Most tests run locally (node + Miniflare). A few exercise live Cloudflare, are excluded from the default suite, and are named `*.integration.test.ts` — run with `bun run --filter <package> test:integration`. They are required before a release.

**`pithy-int-` is a reserved namespace.** Every Cloudflare resource a live test creates is named through `uniqueName()` in [`packages/cloudflare/src/test-utils/harness.ts`](packages/cloudflare/src/test-utils/harness.ts), which composes that prefix itself — you pass only the distinguishing part, `uniqueName("kv")`. `pithy init` refuses a project name that would land inside the namespace, so a `pithy-int-` resource is test debris by definition and never an adopter's. That is what lets the reaper work on the prefix alone: teardown only runs while the process lives, so a run killed by a Ctrl-C or a timeout orphans whatever it had created, and the next run reclaims it. Anything older than twelve hours goes — two orders of magnitude past any plausible suite, so a slow run is never reaped out from under itself.

**The sweep is a property of the run, not of a suite.** [`packages/cloudflare/src/test-utils/reap.ts`](packages/cloudflare/src/test-utils/reap.ts) enumerates every reapable kind — API tokens, D1, KV, Queues, R2, Secrets Store entries, Vectorize, Worker scripts — and each `vitest.integration.config.ts` runs it once via `globalSetup`, before a single suite is collected. It used to live in each suite's `beforeAll`, and that was wrong twice over. Vitest runs no hooks inside a `describe.skipIf(true)`, so every reaper was gated on exactly the credential whose absence lets debris accumulate — no `R2_CREDENTIALS` took the **D1** reaper offline with it. And reaping was per-suite, so `--filter @pithy-sh/vector` created Vectorize indexes and reclaimed none, because the only index reaper lived in another package. Add a kind to the registry, not a `beforeAll` to your suite.

**Use `withNamedResource` when you chose the name.** `withThrowawayResource` skips teardown if `create` rejects, which is right when the id only exists on success and wrong for a named write — `putSecret(name, …)`, `createBucket(name)`, `createDatabase(name)`. There a rejection cannot tell you whether the server accepted the write and failed on the way back, and the resource may now exist under a name you are still holding. `withNamedResource` arms teardown before `create` runs and tears down on the name, so pass it an idempotent delete.

**Two kinds are still not swept, deliberately.** Resources composed under the reserved *project* `pithy-int-test` — the ephemeral D1 and KV that `pithy provision --feature` makes — carry no timestamp `testResourceAge` can read, so no reaper is permitted to touch them. That conservatism is the point: failing to clean up costs pennies, and deleting a resource a running suite still owns turns a green run red for reasons nobody can see. Those suites tear down in an unconditional `afterAll`; an interrupted run leaves debris you must remove by hand.

Two rules follow, and both have been broken before. **Never name a live resource by hand** — a `pithy-secrets-migrate-test-…` database sat unreapable inside the product's own namespace precisely because it skipped `uniqueName`. And when the resource names are themselves under test (`pithy provision --feature`), provision under the reserved project `pithy-int-test` instead: every provisioned name is `<project>-<env>-<thing>` and the project segment comes first and verbatim ([`docs/NAMING.md`](docs/NAMING.md)), so every name it derives lands in the namespace anyway, through the product's own naming path.

**A third rule, from the same family: one credential source must govern the whole run.** A live test that builds a fixture project and hands it to product code has two directories in play, and `loadCloudflareEnv` reads `<dir>/.dev.vars` without walking up — so the fixture resolves `process.env` while the suite's own assertions resolve the package's `.dev.vars`. Where those name different accounts, the run splits: `pithy-int-deploy-…` Workers were uploaded to one account while the existence check and the `DELETE` addressed another, so the assertion 404'd, every teardown was a tolerated 404, and eight live endpoints leaked over four runs. **Give the fixture its own `.dev.vars`, written from the credentials the assertions use** — it pins the run to one account and is the realistic shape besides, since a real project root has one. Then let teardown *prove* the delete: a 404 on a resource the run created is not "already gone", it is "created somewhere else, and still live". Nothing warns you here — a fixture with no `.dev.vars` resolves a complete, coherent pair from the environment, which is exactly how CI runs and is indistinguishable from it. The proving teardown is the guard.

R2 is the one kind that needs more than the API token. Cloudflare refuses to delete a non-empty bucket and emptying one is an S3 operation, so bucket reaping needs `R2_CREDENTIALS`. Secrets Store entries need `SECRETS_STORE_ID`. Without either, the sweep reports that kind as skipped and names the missing variable — "unable to reap" and "nothing to reap" look identical in a log, and only one of them is fine.

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
