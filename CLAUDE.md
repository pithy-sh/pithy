# Pithy — Coding Rules & Standards

Pithy is an open-source, **Cloudflare-native backend kit for mobile *and* web apps**,
shipped as composable capability packages under `@pithy-sh/*` plus a `pithy` CLI.
Home: **pithy.sh**. These are the binding conventions for every package in this
monorepo. Read the companion docs before any structural or surface decision:
`docs/superpowers/specs/2026-06-05-pithy-foundation-design.md` (architecture),
`docs/BRAND.md` (identity + voice), `docs/CLI.md` (CLI behavior), `docs/STACK.md` (toolchain).

## Non-negotiable principles

1. **The user owns their data and infrastructure — always.** Every capability runs in
   the user's own Worker, Cloudflare account, D1, and KV. Never design anything that
   requires data to flow through a Pithy-operated service. No data plane we operate.
2. **Token-first auth, mobile *and* web both first-class.** Mobile uses
   `Authorization: Bearer` with short-lived access tokens + rotated refresh tokens in
   secure device storage; OAuth uses PKCE + deep-link redirects. Web is fully supported:
   the same bearer flow for SPAs, **or** cookie-based sessions. **When cookie/session
   mode is enabled, CSRF protection is enabled with it.** Bearer flows are CSRF-exempt.
3. **Fat package, thin config-driven wiring (the Better Auth model).** Logic lives in
   packages and upgrades via minor releases. The only user-owned surface is thin:
   `pithy.config.ts`, `wrangler.jsonc`, a mount file. Do not push handler code into
   the user's repo by default (`--eject` is an opt-in escape hatch).
4. **Capabilities compose through one contract.** `core`, each capability, and the app
   are all `Capability` objects contributing a subset of {config, migrations, routes,
   middleware, workflows, bindings}. Capabilities depend on **core seams** (e.g.
   `AuthContext`), never on each other's internals.
5. **Cloudflare Workflows are a first-class primitive** for durable, multi-step,
   cross-context work (email, migrations/upgrades, retries, backfills).
6. **Testing and security are paramount** — non-negotiable CI gates, not afterthoughts.
7. **Everything is pithy.** `docs/BRAND.md` voice and `docs/CLI.md` output conventions are *binding*
   for every user-facing surface — CLI output, prompts, help, errors, logs, docs, generated
   `pithy.config.ts` comments, commit and changelog copy. Short sentences. Deliberate
   periods. No fluff, no emoji, no "successfully completed in 2.3s." `Done.` The period is
   the brand; saffron earns its place by carrying meaning. The name is the contract:
   concise, opinionated, no bloat — the stack must read the way it's named.

## Toolchain & repo

- **Bun for everything in dev:** `bun install`, `bun run`, `bunx`. **Never `npm`/`npx`.**
  Bun = package manager + workspaces + script runner (native TS, no `tsx`/`ts-node`).
  Turborepo orchestrates build/cache; **tsdown** (Rolldown) bundles libraries + dts;
  Changesets handles versioning/release.
- **Node 22 LTS is the floor** (TS-7/`tsgo` requires it; CF Workers are at parity). Internal
  dev/build/test scripts assume Bun, but every published `@pithy-sh/*` package is pure ESM
  that also runs on Node 22+/Deno/Workers — **adoption is never gated behind a Bun install.**
- **Bun stays in the workspace, never in a published manifest.** `packageManager` and
  `engines.bun` live **only** in the private root `package.json` (they are dev/workspace
  signals for Turbo + Corepack, invisible to adopters). Every published `@pithy-sh/*`
  package declares `"engines": { "node": ">=22" }` (22 LTS floor, 24 LTS included), omits
  `packageManager`, ships no lockfile, and uses no Bun-only API — so adopters install with
  any package manager on Node 22+. The committed `bun.lock` is a root dev artifact, not
  shipped.
- **JSONC everywhere it's allowed.** Every config file we author or generate uses the
  `.jsonc` extension and is comment-documented whenever the consuming tool recognizes that
  name — `biome.jsonc`, `turbo.jsonc`, `wrangler.jsonc`, and the generated
  `pithy.config`'s JSON outputs. **Exceptions, forced by the tool:** `package.json` stays
  strict JSON (npm/Node/Bun reject comments — never comment it); `tsconfig*.json` and
  `.vscode/settings.json` keep their fixed `.json` names but are JSONC-parsed (comments
  fine). Biome's single `json` block formats `.json` and `.jsonc` alike. Trailing commas
  are off everywhere.
- **Vitest stays the test framework** (`bunx vitest`), with
  `@cloudflare/vitest-pool-workers` for Workers-runtime tests — not `bun test`.
- **Repo: GitHub (public).** CI is **GitHub Actions** with Turbo filtered/affected builds
  — a change builds/tests only its segment; shared-package changes cascade (expected).
- **No barrel re-exports. No re-exporting third-party libraries.** Modern tooling resolves
  deep import paths fine. Direct imports only; re-export a dependency only with an
  amazing, documented reason.

## TypeScript

- Latest TypeScript, **TS-7 (native/`tsgo`) ready**: `verbatimModuleSyntax` and
  `isolatedModules` on, explicit type-only imports, **ESM only**.
- **No `namespace`, no `const enum`, no type-position decorators** — not TS-7-compatible.
- Strict mode on. No `any` in committed code; use `unknown` + narrowing.

## Zod (all data objects)

- **Zod 4.** Codec API: `z.codec`, `.encode()`, `z.input` / `z.output`.
- **A Zod object const and its inferred type ALWAYS share the same name. Never a
  `Schema` suffix.**
  ```ts
  export const User = z.object({ /* … */ });
  export type User = z.output<typeof User>;   // codecs present → z.output
  // export type Foo = z.infer<typeof Foo>;   // plain schema → z.infer
  ```
- Codec helpers are PascalCase nouns (`SQLiteDate`, `SQLiteBoolean`, `JsonDate`).
- Validate at every boundary: HTTP input, KV reads/writes, env/config, D1 rows.
- **Every field in every Zod object MUST have a `.describe()`**, and each object/enum gets
  a top-level `.describe()` too. The schemas ARE our object model's documentation — the
  descriptions feed the self-documenting CLI/config (§Config), generated API/OpenAPI docs,
  and agent tooling. A field without a description is incomplete. (Codec-helper primitives
  themselves are exempt, but any *field* using a codec still describes its meaning.) Prefer
  a meta-test that introspects exported schemas and fails on any field missing a description.

## Data layer (D1 + Kysely + codecs)

- **One Zod schema per table is the entire table definition.** No separate hand-written
  row interface. `z.output` = app shape; `z.input` = SQLite row shape.
- **All JS ↔ SQLite conversion goes through a Zod codec.** A raw `0/1`, an epoch number,
  a manual `new Date()`, or `JSON.stringify` in repository/query code is a smell. Use
  `SQLiteBoolean`, `SQLiteDate`, `sqliteJson(schema)` from `@pithy-sh/core`.
  - SQLite stores booleans as `0|1`, dates as **ms-epoch numbers**, JSON as strings.
  - Codec decode-side input is a **union** (not `z.preprocess`) so the schema stays
    encode-compatible.
- **JSON/config columns** use `sqliteJson(ZodSchema)` so serialization is automatic
  **and the payload is Zod-validated before storing** and after reading.
- **Round-trip rule:** read with `Schema.parse(row)` (decode); write with
  `Schema.encode(value)` then `insertInto(...).values(record)`.
- **Kysely is mandatory** for D1 SQL building. `PithyDatabase` derives from a master
  Zod map's `z.input` side. **`CamelCasePlugin` is mandatory** — camelCase in TS,
  snake_case columns; never hand-write snake_case in query code.
- **ID strategy:** default `id: number` auto-incrementing PK; **UUID/text id for
  security-sensitive or externally-exposed entities** (e.g. `User`) to prevent
  enumeration; **Better Auth tables case-by-case**.
- **Table prefixing (TBD scheme):** every table this toolset provides is **prefixed** to
  avoid clashing with the adopter's own tables (leaning per-capability, e.g. `auth_users`,
  aligned with migration namespaces). Final scheme TBD before the first table ships.
- **Migrations use the Kysely migration model** (TS `up`/`down`, tested rollbacks) —
  **not** raw `.sql` files, and **not** wrangler's D1 migrations. Each package ships
  namespaced, stable-keyed migrations (`auth_0001_…`) merged into one ordered registry
  (library-before-app), run by **our `pithy migrate`** command. Every migration has a
  working, tested `down`.
- **Cross-context upgrades** (beyond D1 schema — KV reshapes, backfills, multi-step data
  migrations) are modeled as **Cloudflare Workflows**, not ad-hoc scripts.

## Cloudflare access: bindings vs REST

- **Inside the Worker → use bindings** (`env.DB`, `env.SESSIONS`, Email binding). Default:
  faster, cheaper, no token, principle-1 aligned. Bindings = data-plane ops on provisioned
  resources.
- **Outside the Worker (CLI, CI, provisioning, control-plane orchestrator — any Node/Bun
  context), and for control-plane/provisioning ops a binding can't do** (create D1,
  manage KV namespaces, deploy/provision Workers) → use the encapsulated CF REST client
  **`@pithy-sh/cloudflare`** (copied/encapsulated/standardized from the CMS
  `libs/data-types/src/cloudflare/` managers), with a scoped CF API token per environment.
  Never hand-roll `fetch` to the CF API outside this client.
- **CF token bootstrap & automation:** the human does two one-time things — `wrangler login`
  (OAuth, for dev/deploy) and a single bootstrap CF API token in `.dev.vars`
  (`CF_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`). From there `pithy` **mints scoped,
  least-privilege tokens** for each use case via the CF API — **always preferring
  account-owned (org-level) tokens over user-bound ones**. Minted tokens are stored/rotated
  via `@pithy-sh/secrets`, per environment; never committed.

## KV

- One namespace per purpose (`SESSIONS`, `CACHE`), never a junk-drawer KV.
- Typed access only: validate values with a Zod object on read and write. No untyped
  `JSON.parse`. Namespace keys per capability (`auth:session:<id>`). TTLs are explicit.

## HTTP (Hono)

- All routing uses **Hono**. Capabilities contribute sub-routers via the `Capability`
  contract; they do not new-up their own app.
- Every route declares a **verification strategy**: `bearer`, `session` (cookie,
  CSRF-protected), `turnstile`, `signed-webhook`, `control-plane` (M2M admin access for the
  premium dashboard — customer-issued scoped credential, default-denied), or `public`. No
  implicit auth.
- `core` defines the `AuthContext` seam and request `Variables`; only `@pithy-sh/auth`
  implements bearer/session validation. Other capabilities use `requireAuth()` / the seam.

## Email, secrets, environments, Workflows

- **Email** is never sent ad-hoc: enqueue a row in the `email_jobs` D1 table and let a
  **Workflow** send via CF Email Service with retries + history. A column per field.
  `@pithy-sh/email` ships polished, responsive starter templates (magic link, OTP, welcome,
  security alert, invite, …) — part of its definition of done.
- **Secrets** go through `@pithy-sh/secrets` (CF Secrets Store + D1, resting-state key
  rotation with overlap windows). Never plaintext secrets in repo or config. Signing
  keys rotate on a schedule.
- **Environments** are first-class: **dev (local) / staging (test users) / production
  (paid users)**. Config and bindings resolve per environment; the CLI scaffolds per-env
  `wrangler.jsonc` and the base URLs client apps use to reach a given environment.

## CLI & configuration

- **`docs/CLI.md` is binding, not advisory** — it specifies command behavior, output styling,
  help, error format, the `p.` alias, `doctor`, and the update-notifier. Build to it.
- **Citty** (unjs) for command structure — TS-first inference, fast cold start, lazy-loaded
  subcommands, built-in shell completions. **`@clack/prompts`** for interactive input.
  **picocolors** + the saffron truecolor helper for color — never raw ANSI; all color flows
  through `src/lib/style.ts`. Cross-arg validation uses the named helpers
  (`requireWhen`/`exactlyOne`/`atLeastOne`/`allOrNone`) for common cases and Zod for complex
  ones. All errors throw `PithyError` (problem line + action line, brand voice). Reuse CMS
  CLI patterns where they fit.
- **Command surface:** `init`, `add`/`remove <capability>`, `worker add`/`list`/`remove`
  (Workers live in `apps/<name>/`; the folder is the registry), `dev` (multi-worker local
  orchestration), `migrate` (+ `--rollback`), `seed`, `upgrade`, `deploy`, `feature`
  create/destroy (worktree lifecycle), `env`, `doctor` (env/health + update check), `alias`
  (install the opt-in `p.` shortcut). The canonical binary is always `pithy`.
- **`apps/` is the Worker registry.** A project's deployable Workers each live in
  `apps/<name>/` (distinct from `packages/*` = `@pithy-sh/*` library capabilities). Every
  command that needs the worker set (`dev`, `deploy`, the port allocator) **discovers it by
  enumerating `apps/*`** — no hand-maintained list. Each worker carries a co-located,
  Zod-described `dev` block: `dev.autostart` (must it run for local dev to function?),
  `dev.readySignal` (regex marking ready), `dev.preferredPort` (hint). The port allocator
  assigns one port **per autostart worker**, reconciling as workers are added/removed.
- **Config must be self-documenting.** Capability config carries human-readable rationale
  (Zod `.describe()` + a `whenToEnable` manifest field). `pithy init` offers **app-target
  profiles** (mobile-only / web-only / both) that flip a coherent default set, and the CLI
  explains *why* to enable each feature. A non-expert should configure the right backend
  from the CLI's questions alone, and `pithy.config.ts` is written with comments.
- **Every CLI command must be agent-drivable:** works **non-interactively** (full flags,
  no required prompt) and supports **`--json` structured output**, in addition to the
  interactive `@clack/prompts` path. Humans and AI agents (Claude/Codex/Cursor skills,
  MCP) both drive the same CLI — design for both from day one.
- A **seed/test-data harness** (`pithy seed`, driven by the same Zod schemas/codecs)
  serves both local dev and ephemeral CI environments.
- **Every lifecycle command is CI-automatable:** `migrate` (promote), `migrate --rollback`
  (downgrade), `upgrade`, `seed`, provisioning, and feature teardown run headlessly (exit
  codes + `--json`), are **idempotent** (safe to re-run), and target a specific `--env`. The
  merge-to-`main` CI job runs the full feature cleanup (promote migrations, delete ephemeral
  D1/KV/preview Worker via `@pithy-sh/cloudflare`, unregister the worktree safely) with no
  human in the loop — the same commands a developer runs locally.
- **Worktree dev lifecycle:** the CLI creates `feature/<issue>-<name>` worktrees,
  provisions their ephemeral CF resources (D1/KV), migrates + seeds them, and tears
  everything down on merge. **Worktree removal follows the CMS-safe process:**
  `rm <worktree>/.git && git worktree prune` — **never** `rm -rf` or `git worktree remove`
  (recursive deletion triggers inotify storms that crash on Linux). Delete CF resources
  first, then prune. **Dev vars:** wrangler loads one `.dev.vars` per worker from
  that worker's own dir (no merge; `.dev.vars.local` is not loaded). So `pithy`
  **composes one consolidated root `.dev.vars`** per worktree (shared team secrets +
  generated worktree-specific values; port CMS `generate-dev-vars`), and **each worker
  symlinks its `.dev.vars` to that root file** via a package.json target (CMS pattern) —
  single source of truth. Git-ignored; per-env runs use `.dev.vars.<environment>`.
  Production secrets come from `@pithy-sh/secrets`, never `.dev.vars`.
- **`pithy dev` is a multi-worker orchestrator** (port the CMS `scripts/dev.ts`): it runs
  every worker under one supervising process, labels/colorizes their output to terminal +
  `logs/dev.log`, tracks a git-ignored `.dev-state.json`, reaps orphaned `workerd`/`wrangler`
  (lsof sweep), and tears down whole process groups (`setsid`, SIGTERM→SIGKILL). **Ports are
  per-feature, allocated from a central registry:** a single git-ignored **`.dev-ports.json`
  at the main repo root** (resolved from any worktree via `git rev-parse --git-common-dir`)
  maps each `feature/<issue>-<name>` branch to its port block. `pithy feature create` locks,
  reads (sees all taken blocks), assigns the lowest free non-overlapping block, and writes
  its key; `feature destroy`/merge-cleanup deletes the key. Each worktree gets its own block
  projected into a git-ignored `.dev.ports.json` (surfaced as `*_PORT`/`*_ORIGIN` in
  `.dev.vars`) — distinct from `.dev-state.json` (the running session's pids). So multiple
  worktrees run in unison without conflict and each feature's workers reach each other over
  localhost — never wrangler's cross-`wrangler dev` service registry. `pithy dev` still
  verifies a port is free on **both** `127.0.0.1` and `::1` and scans forward otherwise.

## Packaging, build & releases

- **Bun workspaces** monorepo. **Turborepo** for build + caching. **tsdown** (Rolldown) for
  library bundling + dts. **Changesets** for versioning/release. **Biome** for lint + format
  (not ESLint/Prettier).
- **Clean commits are gated locally and in CI.** **Husky** + **lint-staged** run Biome on
  staged files; **commitlint** enforces **Conventional Commits** (`feat`/`fix`/`docs`/…,
  scoped to `@pithy-sh/*` package names). A commit that fails Biome or commitlint is
  rejected — no routine `--no-verify`. Commit copy follows the brand voice (principle 7).
- Core capability packages are **MIT/Apache**; anything that could become a paid product
  starts more restrictive (BSL/AGPL). Capability boundaries are real package boundaries.

## Testing

- **Vitest**, co-located (`feature.ts` → `feature.test.ts`).
- Workers-runtime behavior uses `@cloudflare/vitest-pool-workers` with real D1/KV
  bindings (Miniflare), not mocks, where it matters.
- Every migration's `up` **and** `down` is tested. Every codec round-trips in tests.
- CI gates merges on tests + typecheck + Biome.

## Security

- Security is a first-class deliverable. Validate every boundary. Declare a verification
  strategy on every route. CSRF protection whenever cookie/session mode is on. Secrets
  only via `@pithy-sh/secrets`. An OWASP-aligned security review is part of each
  capability's definition of done.
- **Emit audit events** for security-relevant actions (auth, entitlement, admin changes)
  via the `@pithy-sh/audit` seam — Pithy provides audit logging since Better Auth ships no
  audit plugin.

## Definition of done (any capability)

A capability is "done" only when it ships: the package, its manifest, namespaced
migrations with tested rollbacks, its routes/middleware/workflows with declared
verification strategies, `pithy add <capability>` wiring, tests, a security review, and
docs. Docs are part of the product, not an afterthought.
