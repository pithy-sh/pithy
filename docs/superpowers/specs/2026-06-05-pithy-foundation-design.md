# Pithy — Foundation Design (Phase 0)

> Status: **Approved design**, ready for implementation planning.
> Date: 2026-06-05 (revised same day with cross-cutting decisions §10)
> Scope of this spec: **Phase 0 (Foundation)** + the cross-cutting decisions that every
> later phase inherits. Concrete capabilities (auth, email, turnstile, leaderboard,
> payments, sync, secrets) each get their own spec → plan → build cycle.

## 1. What we're building

An open-source, **Cloudflare-native backend kit for mobile *and* web apps** — the
"Supabase-on-Cloudflare" positioning, distributed as **capabilities you compose into
your own Worker** rather than a managed service. The product is **Pithy** — home at
**pithy.sh**, shipped from the `@pithy-sh` npm org. The brand promise *is* the position:
concise, opinionated, no bloat (see `docs/BRAND.md`, `docs/CLI.md`, `docs/STACK.md`).

The product surface is a `pithy` **CLI** plus a set of `@pithy-sh/*` npm packages.
The promise: stand up a production-grade backend (auth, entitlements, leaderboards,
etc.) on Cloudflare Workers + D1 + KV in minutes, while the app team keeps **100%
ownership of their data and infrastructure.**

## 2. Load-bearing architectural decisions (locked)

1. **Distribution — C3: capability packages + CLI.** Capabilities ship as npm packages
   under `@pithy-sh/*`. A `pithy` CLI is the primary surface (`init`, `add`,
   `migrate`, `deploy`, …). Monorepo, **Bun** workspaces, Turborepo, Changesets.

2. **Code boundary — fat package, config-driven wiring (the Better Auth model).** Heavy
   logic lives in packages and upgrades via minor releases. The CLI scaffolds only a
   thin user-owned surface: `wrangler.jsonc` bindings, `pithy.config.ts`, a mount
   file. Hand-editing handlers is an opt-in `--eject` escape hatch, never the default.

3. **Data & infrastructure ownership — 100% the user's, always.** Every capability runs
   in the user's own Worker, account, D1, and KV. We ship code; we never see, store, or
   proxy data. The future hosted control plane connects via the customer's own scoped
   API tokens — still their data plane.

4. **Migrations — namespaced providers merged into one ordered registry**, run by **our
   own `pithy migrate` command** (not wrangler's D1 migrations). See §6.5 and §10.10.

5. **Token-first auth, mobile *and* web both first-class.** See §5. (Revised: web is a
   MUST, not a secondary convenience.)

6. **Cloudflare Workflows are a first-class primitive** for durable, multi-step,
   cross-context operations (email sending, migrations/upgrades, retries). See §10.10.

## 3. Toolchain, repo & packaging

- **Runtime/dev: Bun.** `bun install`, `bun run`, `bunx` — never `npm`/`npx`. Bun
  provides install + workspaces + native-TS script running (no `tsx`/`ts-node`). Turborepo
  orchestrates builds/cache; **tsdown** (Rolldown) bundles libraries + dts; Changesets
  handles versioning/release; **Vitest + `@cloudflare/vitest-pool-workers`** remains the
  test framework (Workers-runtime fidelity), invoked via `bunx vitest` (not `bun test`).
- **Node 22 LTS is the floor** (TS-7/`tsgo` requires it; CF Workers are at parity). Dev/
  build/test scripts assume Bun, but published `@pithy-sh/*` packages are pure ESM that
  also run on Node 22+/Deno/Workers — **adoption is never gated behind a Bun install.**
- **Commit hygiene gated locally + in CI:** Husky + lint-staged run Biome on staged files;
  commitlint enforces Conventional Commits (`@pithy-sh/*`-scoped). Failing either rejects
  the commit. See `docs/STACK.md` for the full tooling rationale; `docs/BRAND.md`/`docs/CLI.md` govern all
  user-facing copy and output — **they are binding, "the way," for every surface.**
- **Repo: GitHub (primary, public).** OSS discoverability drives the GTM. CI is **GitHub
  Actions**. The existing GitLab-Issues engineering workflow (glab, WORKFLOW.md) needs a
  GitHub-flavored adaptation — tracked separately, not in Phase 0 code.
- **Licensing:** core packages MIT/Apache; anything that could become a paid product
  starts more restrictive (BSL/AGPL).
- **No barrel re-exports; no re-exporting third-party libraries.** Modern tooling
  resolves deep paths fine. Direct imports only. Re-export a dependency *only* with an
  amazing, documented reason. (Matches the CMS.)

## 4. Package decomposition & build order

```
pithy-sh/                      # repo, @pithy-sh npm org, GitHub
├── packages/
│   ├── @pithy-sh/core/           # ← Phase 0. data layer, Hono factory, capability
│   │                           #   contract + manifest, Zod codecs, migration registry,
│   │                           #   KV/D1 helpers, config + environments, verification
│   │                           #   seam, Workflow helpers
│   ├── @pithy-sh/cli/            # ← Phase 0. `pithy` binary (Citty + completions + clack + picocolors)
│   ├── @pithy-sh/secrets/        # secrets store + resting-state key rotation (port from CMS)
│   ├── @pithy-sh/email/          # CF Email via D1 job table + Workflow
│   ├── @pithy-sh/turnstile/      # bot-protection middleware (no DB footprint)
│   ├── @pithy-sh/auth/           # Better Auth: magic-link, OTP, Google, Apple — mobile+web
│   ├── @pithy-sh/audit/          # audit-trail capability + seam (Better Auth has no audit plugin)
│   ├── @pithy-sh/leaderboard/    # optional plugin (daily/weekly/monthly/yearly/all-time)
│   ├── @pithy-sh/testers/        # early-access/tester invitations + opt-in tracking (Play 12/14d)
│   └── @pithy-sh/cloudflare/     # encapsulated CF REST client (ported from CMS) — out-of-Worker ops
├── templates/starter/          # what `pithy init` scaffolds
├── tooling/{tsconfig,biome}/   # shared configs (TS-7 ready)
├── integrations/               # AI agent integrations: Claude/Codex/Cursor skills+plugins, MCP
├── apps/{docs,showcase}/       # docs site + health-tracker dogfood app
└── examples/
```
(`@pithy-sh/email` ships polished responsive email templates — §10.21.)

| Phase | Deliverable | Definition of done |
|-------|-------------|--------------------|
| **0 — Foundation** *(this spec)* | Bun monorepo + tooling + GH Actions CI + `@pithy-sh/core` + `pithy init` | `pithy init` produces a deployable Worker that boots across **dev/staging/prod**, loads+validates per-env config, runs the (empty) migration registry, serves `GET /health` |
| **1 — Auth wedge** | `@pithy-sh/secrets` + `@pithy-sh/email` (incl. polished templates §10.21) + `@pithy-sh/turnstile` + `@pithy-sh/auth` + `@pithy-sh/audit` | `init` → `add auth` → working magic-link/OTP/Google login on **both** a mobile bearer flow and a web flow, audit events emitted, full docs |
| **2** | leaderboard, then storage (R2) | each at 95% + docs |
| **3** | payments/IAP (Apple+Google), integrations/webhooks, app-store onboarding helpers (§10.7), `@pithy-sh/testers` early-access (§10.22) | entitlements bound to users; signed-webhook verification |
| **4+** | AI agent integrations (§10.20: Claude/Codex/Cursor skills+plugins, MCP); docs polish, showcase app, launch; later `pithy-sync` (offline-first); hosted admin dashboard (pro) | — |

Only Phase 0 is designed here; the roadmap proves the abstraction doesn't preclude
later work. The user has stated several details below are *phase-agnostic* — they are
captured as cross-cutting decisions (§10) regardless of when they ship.

## 5. Auth: token-first, mobile and web both first-class

**Mobile** authenticates once, receives a short-lived access token + rotated refresh
token, stores them in secure device storage, and sends `Authorization: Bearer` on every
request, refreshing silently on 401. OAuth uses **PKCE + deep-link/custom-scheme
redirects**; native Google/Apple identity tokens verified server-side.

**Web** is fully supported with two modes: (a) the same **bearer** flow for SPAs that
store tokens, or (b) **cookie-based sessions** for traditional web. **When cookie mode is
enabled, CSRF protection is enabled with it** — so unlike a mobile-only design, CSRF *is*
in scope whenever cookies are used. Bearer flows remain CSRF-exempt (no ambient creds).

**The auth seam:** `@pithy-sh/core` defines `AuthContext` + request `Variables` but no auth
logic. `@pithy-sh/auth` fills the `bearer`/cookie validation. Other capabilities depend
only on the seam + `requireAuth()`.

**Per-route verification strategies** (declared per route, no implicit auth):

```ts
type VerificationStrategy =
  | 'bearer'         // mobile/web user token
  | 'session'        // web cookie session (CSRF-protected)
  | 'signed-webhook' // store/integration callback — signature-verified, no user
  | 'control-plane'  // M2M: the premium dashboard calling the customer's admin endpoints (§10.23)
  | 'public';

// Turnstile is NOT a verification strategy. A humanity check answers "is this a human?", never
// "who is this?", so it can never be a route's identity gate. It stacks as composable middleware on
// top of any strategy above — e.g. a `public` signup route that still requires a Turnstile token.
// See @pithy-sh/turnstile.
```

**Signing keys rotate at rest** via `@pithy-sh/secrets` (§10.2): access-token signing keys
rotate on a schedule with an overlap window so in-flight tokens still verify.

**Entitlements bind to the user** (Phase 3, designed for now): verified Apple/Google
transactions are stamped with the authenticated `userId`; "Restore Purchases" re-binds.
An **entitlement seam** lets capabilities gate features without depending on payments
internals.

**Persistence stance:** server-authoritative — "your backend is the backup." New device
logs in and re-reads. A lightweight **device registry** (device id, platform, push
token, per-device sessions, keyed on `userId`) rides with auth in Phase 1. Full
offline-first sync is a future `pithy-sync` capability.

## 6. Data-layer conventions

Mirror the CMS conventions (see the local CMS source notes), adopted as-is except migrations (§6.5).

### 6.1 One schema per table, codecs inline
A single Zod object per table is the whole definition; the type shares its name via
`z.output`. No hand-written row interface.

```ts
export const User = z.object({
  id: UUID,                            // security-sensitive entity → UUID (see §6.6)
  email: z.email(),
  emailVerified: SQLiteBoolean,        // boolean ↔ 0|1
  settings: sqliteJson(UserSettings),  // validated object ↔ JSON string (§10.8)
  createdAt: SQLiteDate,               // Date ↔ ms-epoch number
});
export type User = z.output<typeof User>;
```

`z.output` = app shape; `z.input` = SQLite row shape.

### 6.2 Codec helpers in `@pithy-sh/core`
Ported from `sqliteCodecs.ts`: `SQLiteDate`, `SQLiteBoolean`, `sqliteJson(schema)`,
`JsonDate`, `IanaTimezone`. Decode input is always a **union** (not `z.preprocess`) to
stay encode-compatible.

### 6.3 Round-trip rule
Read: `User.parse(row)` (decode). Write: `User.encode(user)` →
`insertInto("users").values(record)`.

### 6.4 Kysely `PithyDatabase` from a master Zod map
Master Zod object maps table-name → schema; the Kysely interface is the `z.input` (row)
side with id-generation applied per table. `CamelCasePlugin` mandatory. The map is
assembled by `createBackend` merging each capability's table contributions.

### 6.5 Migrations — intentional divergence from the CMS
The CMS uses raw `.sql` + a bespoke KV orchestrator. **Pithy uses the Kysely migration
model** (TS `up`/`down`, tested rollbacks) in the namespaced registry, executed by our
own CLI/Workflow (§10.10). Deliberate; do not revert to `.sql`.

### 6.6 ID strategy
- **Default: `id: number`, auto-incrementing primary key** (numeric `Generated`).
- **Security-sensitive / externally-exposed entities (e.g. `User`): UUID/text id** to
  avoid enumeration.
- **Better Auth tables: case-by-case** — evaluate per table as we integrate (we made
  mixed choices in the CMS; revisit deliberately).

### 6.7 Versions
Zod **4** (codec API). TypeScript latest, **TS-7 ready** (`verbatimModuleSyntax`,
`isolatedModules`, ESM, no `namespace`/`const enum`/type-position decorators).

### 6.8 Every Zod object is self-describing
**Every field in every Zod object MUST have a `.describe()`**, plus a top-level
`.describe()` per object/enum. The object model — which is essentially the whole system —
documents itself. Descriptions feed the self-documenting CLI/config (§10.15), generated
API/OpenAPI docs, and agent tooling. Codec-helper primitives are exempt, but fields using
them still describe their meaning. Enforced by a meta-test that fails on any undescribed
field.

## 7. The capability contract + manifest

`core`, each capability, and the app are all `Capability` objects contributing a subset
of {config, migrations, routes, middleware, bindings} — **each contribution
independently optional** (Turnstile = middleware only; leaderboard = all).

```ts
export interface Capability {
  name: string;
  config: z.ZodType;                     // validated per-environment config/secrets
  migrations?: MigrationProvider;        // namespaced (auth_0001_…)
  routes?: (app: Hono<{ Variables: PithyVars }>) => void;
  middleware?: PithyMiddleware[];
  workflows?: WorkflowSpec[];            // durable jobs this capability registers (§10.10)
  requiredBindings: BindingSpec;         // D1 / KV / Email / Workflow / secrets
}
```

A static `pithy.manifest.json` per package drives `pithy add`/`upgrade`
(declarative: bindings, peer/optional capabilities, migration namespace, scaffold steps).

`createBackend` (core) merges migrations into the ordered registry, composes middleware,
mounts routes, registers Workflows, assembles the Kysely `PithyDatabase`, and
**validates all required bindings at boot — fail-fast** with a clear message.

## 8. Phase 0 scope — definition of done

In scope:
1. **Bun** monorepo: workspaces, Turborepo, Changesets, shared `tooling/` (tsconfig +
   Biome), TS-7-ready config, **GitHub Actions CI with Turbo-filtered/affected builds**
   (§10.12).
2. `@pithy-sh/core`: `createBackend` (Hono factory, fail-fast binding validation, Kysely
   `PithyDatabase` with `CamelCasePlugin`+`D1Dialect`); the `Capability` contract +
   manifest type; the migration **registry** over the Kysely model; Zod codec helpers;
   typed KV helpers; the verification-strategy seam + `AuthContext`; the **environments**
   model (§10.3); **Workflow** registration helpers (§10.10); Zod-validated config loader.
3. `@pithy-sh/cli` (Citty + built-in shell completions + `@clack/prompts` interactive UX +
   picocolors color layer): `init`, `add`, `migrate`, and per-environment `dev`/`deploy`
   scaffolding (§10.3). Output/voice per `docs/CLI.md` + `docs/BRAND.md`.
4. `templates/starter`: minimal deployable Worker — `pithy.config.ts`, per-env
   `wrangler.jsonc`, health route, empty app migration set.

Out of scope (later): concrete auth/email/turnstile/leaderboard/payments/secrets
capabilities, `--eject`, docs site, showcase app, offline sync, hosted dashboard.

DoD: from an empty dir, `pithy init` yields a Worker that `bun run dev` (wrangler/
miniflare) boots, loads+validates per-env config, runs the empty migration registry, and
serves `GET /health` → 200 — verified for the **dev** environment, with **staging/prod**
config paths present.

## 9. Testing & security (utmost priority — §10.13)

- **Testing:** Vitest, co-located (`feature.ts`→`feature.test.ts`). Workers-runtime tests
  use `@cloudflare/vitest-pool-workers` with real D1/KV (Miniflare), not mocks, where it
  matters. Every migration `up`+`down` tested; every codec round-trips in tests. CI gates
  merges on test + typecheck + Biome.
- **Security:** treat as a first-class deliverable, not a review afterthought. Secrets via
  `@pithy-sh/secrets` (CF Secrets Store + resting-state rotation), never plaintext in repo
  or config. Validate at every boundary (HTTP, KV, D1, env). Every route declares a
  verification strategy. CSRF protection on cookie/session mode. A security review
  (OWASP-aligned) is part of each capability's definition of done.

## 10. Cross-cutting decisions (phase-agnostic)

10.1 **Web + mobile.** Both are first-class targets; nothing may be mobile-only. (§5)

10.2 **Secrets & key rotation.** Port the CMS model (`SecretRegistry` over CF Secrets
Store + D1 `system_secrets` + `secret_rotations`) into `@pithy-sh/secrets`. Resting-state
rotation with overlap windows; auth signing keys are the first consumer.

10.3 **Environments: dev (local) / staging (live, test users) / production (live, paid
users).** First-class in config and CLI. `pithy.config.ts` resolves per-environment
settings/bindings; `wrangler.jsonc` uses environment stanzas. CLI: `pithy dev`
(local/miniflare), `pithy deploy --env staging|production`. The framework exposes
environment identity so **client apps can be pointed at a preproduction backend** (test
users on staging, paid users on production) — including scaffolding the per-env base URLs
the mobile/web clients consume.

10.4 **Bun everywhere** for dev/scripts (§3).

10.5 **No barrel exports; no re-exporting libraries** without an amazing, documented
reason (§3).

10.6 **CLI stack:** **Citty** (unjs) for command structure — TS-first inference, fast cold
start, lazy subcommands, **built-in shell completions**; **`@clack/prompts`** for interactive
inputs; **picocolors** + a saffron truecolor helper for color (all color via `src/lib/style.ts`,
never raw ANSI). Cross-arg validation: named helpers (`requireWhen`/`exactlyOne`/`atLeastOne`/
`allOrNone`) for common cases, Zod for complex ones; errors throw `PithyError` (problem +
action lines). Reuse CMS CLI patterns (`packages/tools`, `config.ts`, logger) where they fit.
**`docs/CLI.md` and `docs/BRAND.md` are binding** for command behavior, output, help, errors, and the
`p.` alias / `doctor` / update-notifier surfaces — every surface must read pithy (principle 7).

10.7 **App-store onboarding helpers (bonus, Phase 3).** Where we can reduce friction:
serve the deep-link association files the OAuth/PKCE redirects need
(`/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json`), and document
App Store Connect / Play Console setup. Deeper automation (App Store Server API key
provisioning, fastlane-style flows) is exploratory — research before committing.

10.8 **JSON columns are codec-validated.** Any application/JSON config column uses
`sqliteJson(ZodSchema)` so (de)serialization is automatic **and the payload is Zod-
validated before it is stored** and after it is read.

10.9 **ID semantics** per §6.6 (numeric default; UUID for security-sensitive; Better Auth
case-by-case).

10.10 **Migrations & Workflows are CLI/Workflow-controlled.**
- Schema migrations run via **our `pithy migrate`** command against the Kysely
  registry — *not* wrangler's D1 migration system (the two don't coordinate; we own ours).
- **Cross-context upgrades** (anything beyond D1 schema — KV reshapes, backfills,
  multi-step data migrations) are modeled as **Cloudflare Workflows** (durable execution),
  porting the CMS "migration job" concept onto Workflows.
- **Leverage Workflows generally** as a primary CF tool (migrations, email, retries,
  backfills). Capabilities register Workflows via the contract (§7).
- **Every lifecycle operation is CI-automatable and headless.** `pithy migrate` (apply /
  promote), `pithy migrate --rollback` (downgrade — Kysely `down`), `pithy upgrade`
  (apply package/capability upgrades + their new migrations), provisioning, and teardown
  must all run non-interactively in CI with exit codes + `--json` (§10.20), be **idempotent**
  (safe to re-run), and target a specific `--env`. No lifecycle task may require a human
  prompt.
- Future **pro feature:** expose migration/Workflow/job management through the hosted
  admin dashboard.

10.11 **Email = D1 job table + Workflow.** Every outbound email is a row in an
`email_jobs` D1 table (a column per field: to/from/subject/template/payload/status/
attempts/timestamps/error). A **Workflow** is triggered to send via CF Email Service,
handling retries and recording history. This is the predictable, auditable model —
replaces ad-hoc in-request retry. (CMS retry logic may be ported where useful.)

10.12 **Monorepo CI (always a monorepo).** GitHub Actions + Turborepo filtered/affected
builds: a change builds/tests only its segment; a change to a shared package (e.g. core
data-types) cascades to dependents — that cascade is expected and fine. Remote caching to
keep CI fast.

10.13 **Testing & security are paramount** (§9) — non-negotiable gates.

10.14 **Repo host = GitHub** (§3); GitLab workflow adaptation tracked separately.

10.15 **Guided, self-documenting configuration (profiles / "app targets").** Every
capability and sub-feature is enable/disable in `pithy.config.ts`, and **the user must
be able to understand *why* to enable each one.** Two mechanisms:
- **App-target profiles** drive sensible defaults. `pithy init` asks what's being built
  — e.g. *mobile-only (iOS + Android)*, *web-only*, or *mobile + web* — and that profile
  flips a coherent default set. Example: choosing **mobile-only, Play + App Store, no web**
  disables cookie/`session` mode (and its CSRF machinery), enables the deep-link
  association files (§10.7), and presets OAuth for native redirects. Choosing **web**
  enables `session` mode + CSRF.
- **Self-documenting toggles.** Each capability's config schema carries human-readable
  rationale (Zod `.describe()` + a `whenToEnable` field in the manifest). The CLI surfaces
  this in interactive prompts ("here's why you'd enable this / skip it") and writes a
  commented `pithy.config.ts`. `pithy add`/`remove`/`set` toggle features from the CLI.
The principle: a non-expert should be able to configure the right backend for their app
*from the questions the CLI asks*, without reading the source.

10.16 **Table name prefixing (TBD — decision pending).** To avoid clashes with the app's
own tables, **all tables this toolset provides are prefixed.** Open decision: a single
global prefix (e.g. `cb_users`) vs a per-capability prefix aligned with the migration
namespace (e.g. `auth_users`, `leaderboard_scores`). Leaning per-capability (consistent
with the `auth_0001_…` migration keys), possibly with the prefix configurable. Resolve
before the first table ships in Phase 1.

10.17 **CI promotion strategy + ephemeral environments + seed harness.** We provide an
opinionated **feature-branch → main** promotion flow as stubbed, ready-to-use CI for
**both GitHub Actions and GitLab CI** (so adopters on either host get it):
- **Base flow (easy, ships early):** PR/MR opens → Turbo filtered build + typecheck +
  Biome + Vitest; merge to `main` → Changesets version + publish/deploy. Stubbed workflow
  files scaffolded by `pithy init`.
- **Ephemeral per-branch environments (medium, high-value DX — see §feasibility in the
  design discussion):** on a feature branch, CI provisions a **clean D1** (via the CF
  API), runs `pithy migrate` + `pithy seed` against it, binds it to a **preview Worker
  deployment**, and tears it all down on close. Gives every feature a clean, seeded
  environment. Provided as opinionated CI + `pithy feature` subcommands.
- **Seed / test-data harness (easy–medium):** port the CMS seeder model — a `pithy seed`
  command driven by the same Zod schemas/codecs, used by both local dev and ephemeral CI
  envs.
- **Merge-to-`main` runs full feature cleanup in CI.** The provided merge job must, with no
  human in the loop, perform every lifecycle + teardown task for the feature: promote
  migrations as needed, delete the feature's ephemeral D1/KV + preview Worker via
  `@pithy-sh/cloudflare` (§10.24), and unregister the worktree the safe way (§10.18). All of
  these are the CI-automatable, idempotent commands from §10.10 — so the same commands a
  developer runs locally are exactly what CI runs.
This is a roadmap **DX/CI capability** (base CI is Phase 0/1; ephemeral envs + seed are a
fast-follow), explicitly to help adopters reach a steady-state delivery pipeline fast.

10.18 **CLI-orchestrated worktree dev lifecycle.** The CLI owns the whole "how do I make
a change" loop, not just CI — and it aligns with the existing `feature/<issue>-<name>`
branch + `.worktrees/<issue>-<name>/` convention:
- **Create/prep:** `pithy feature create <issue> <name>` (working name) creates the git
  worktree on a `feature/<issue>-<name>` branch and **provisions the cloud resources that
  feature needs** — an ephemeral D1 (+ KV namespaces) — then runs `pithy migrate` +
  `pithy seed` and primes secrets/dev vars (below). The developer gets an isolated
  workspace wired to its own clean, seeded backend.
- **Teardown:** on merge to `main` (or `pithy feature destroy`), **full teardown** of
  the worktree's D1/KV/preview Worker and the worktree itself. A scheduled sweeper catches
  stragglers (resource limits make reliable teardown mandatory, not optional).
  - **Worktree removal MUST follow the CMS-documented safe process:** `rm <worktree>/.git`
    then `git worktree prune`. **Never** `rm -rf <worktree>` or `git worktree remove` —
    recursively deleting a worktree's contents triggers **inotify storms that crash on
    Linux**. The CLI's teardown implements exactly this sequence (delete CF resources
    first, then `rm .git` + `git worktree prune`).
- **Local counterpart of §10.17:** the same provisioning/teardown primitives back both
  local worktrees and ephemeral CI environments — one mechanism, two entry points.
- **Dev vars / secrets priming — one root file, symlinked into every worker.** Wrangler
  loads exactly **one** `.dev.vars` per worker, from that worker's own directory (or, with
  `--env <name>`, only `.dev.vars.<name>` — the base is *not* merged; `.dev.vars.local` is
  not loaded). The monorepo has multiple workers, so:
  - `pithy` **composes one consolidated root `.dev.vars`** for the worktree (port the CMS
    `generate-dev-vars` model) by merging a shared team-secrets source with generated
    worktree-specific values (ephemeral D1/KV ids, per-feature keys). The merge is the
    CLI's job, not wrangler's.
  - **Each worker package symlinks its `.dev.vars` to that root file** via a `package.json`
    target (the CMS pattern), so there is a single source of truth and no per-worker copy
    to keep in sync.
  - The generated root file is git-ignored; per-environment local runs use
    `.dev.vars.<environment>`; production secrets come from `@pithy-sh/secrets` / CF Secrets
    Store (§10.2), never `.dev.vars`. (Alternative considered: wrangler's `.env` /
    `.env.<env>.local` layering, which *does* merge — rejected to keep one clear secrets
    convention.)
- **Per-feature port allocation via a central registry (so multiple worktrees run in
  unison).** Port collisions are the one thing that stops two feature worktrees running at
  once. The allocator is a single **git-ignored registry at the main repo root** (the parent
  of `.worktrees/` — the one place every linked worktree resolves identically, via
  `git rev-parse --git-common-dir`): **`.dev-ports.json`**, a map **keyed by feature branch**
  → that feature's port block, e.g. `{ "feature/12-auth": { "backend": 8800, "frontend":
  8801 }, "feature/34-email": { "backend": 8820, … } }`.
    The inner keys are the **autostart worker names discovered in `apps/`** (§10.26/§10.27) —
    one port per worker in the dev set.
  - `pithy feature create` takes a short **file lock**, reads the registry (so it *sees every
    block already taken*), assigns the **lowest free, non-overlapping block** sized to the
    feature's autostart workers, writes its key, and unlocks. Reading the whole picture in one
    shot is what makes collision impossible; when the worker set changes, the entry is
    reconciled (add/free per-worker ports) rather than reallocated.
  - `pithy feature destroy` (and the merge-to-`main` cleanup) **deletes its key**, returning
    the block to the pool for reuse — add/remove is a single keyed mutation, no orphan files.
  - Each worktree also gets a git-ignored **`.dev.ports.json`** (just its own block, projected
    from the registry entry) that `pithy dev` reads as its start ports; the `*_PORT` and
    derived `*_ORIGIN` values are surfaced into the composed `.dev.vars`. The registry is the
    *allocator*; the per-worktree file is the local copy `dev` consumes. (Both are distinct
    from `.dev-state.json`, the *running session's* runtime pid/child-pids — §10.26.)
  - `pithy dev` (§10.26) still verifies each assigned port is actually free on both
    `127.0.0.1` and `::1` and scans forward if something external grabbed it. Because the
    blocks are disjoint and stable, every worktree boots and its workers reach each other on
    their assigned localhost ports.

10.19 **Audit logging (`@pithy-sh/audit`).** Better Auth has **no official audit plugin**
(only an Admin plugin), so Pithy ships its own. Port the CMS audit model
(`KVAuditProvider` — audit trail with TTL) into a `@pithy-sh/audit` capability exposing an
**audit seam**: any capability emits structured audit events (actor `userId`, action,
resource, timestamp, metadata) without depending on the audit implementation. Security-
relevant by default (auth events, entitlement changes, admin actions). A natural feed for
the future hosted admin dashboard. Roadmap: lands with/just after auth (Phase 1–2).

10.20 **AI agent integrations + agent-friendly CLI.** A headline differentiator: ship
first-party **agent integrations** — Claude Code skills/plugins (and Codex, Cursor rules)
— plus optionally a Pithy **MCP server**, all driving the `pithy` CLI so an agent can
`add auth`, scaffold, migrate, and spin up feature worktrees autonomously. This makes the
CLI the automation substrate for agentic development. **Now-decision it forces:** every
CLI command must work **non-interactively** (full flags, no required prompts) and support
**`--json` structured output**, in addition to the `@clack/prompts` interactive path —
so both humans and agents can drive it. Build the CLI agent-friendly from day one;
ship the skills/plugins as a dedicated phase (Phase 4).

10.21 **Email starter templates (with `@pithy-sh/email`).** Ship a set of polished,
responsive transactional email templates (magic link, OTP, welcome, security alert,
invite, password-changed, etc.) — "sexy as hell," built on the best-known battle-tested
responsive layouts (e.g. Postmark's MIT-licensed transactional templates as a starting
point — verify license before vendoring). Templates are themeable and are part of the
email capability's definition of done, not an afterthought.

10.22 **Early-tester / early-access management (exploratory, Phase 3).** A real adopter
pain we can ease: Google Play now requires new **personal** developer accounts to run a
closed test with **≥12 testers opted in for 14 continuous days** before production access.
Propose a `@pithy-sh/testers` (early-access) capability that manages **tester invitations,
opt-in tracking, cohort status, and the 14-day window**, leveraging `@pithy-sh/email`
(invites), the device registry (§5), and the staging environment (§10.3) — turning a
painful manual process into a tracked flow. Feasibility caveat: direct Play Console
automation is bounded by Google's Play Developer API (testing-track management is partial);
**research before committing scope.** Apple TestFlight is an analogous target.

10.23 **Premium control-plane access seam (configured by default, access denied by
default).** The future hosted (pro) dashboard must reach into the customer's **own**
primary Worker through library-provided **management endpoints** — without Pithy
operating any data plane (principle 1). Design:
- The library ships, by default, an **admin/management API surface**: capabilities
  contribute admin routes (run migrations, user admin, leaderboard admin, log/job
  inspection) gated by a dedicated **`control-plane` verification strategy**.
- **The customer's Worker is the authority; the control plane is a client.** It presents
  a **scoped, revocable, rotated credential the customer mints** (via `@pithy-sh/secrets`).
  The seam is **present by default but denies all access until the customer provisions a
  credential** — there is no backdoor and nothing is enabled silently.
- **Mechanism is an open decision** (the user is undecided: OAuth vs API key). Recommended
  default: a **customer-issued scoped token verified by the Worker**, leaning **asymmetric**
  (the control plane holds a private key; the customer registers and can rotate/revoke the
  trusted public key) so the customer **never shares a secret with us**. A simpler scoped
  **API key** (HMAC, stored in the customer's Secrets Store) is the fallback for v1. Finalize
  when the control plane is designed (year 2+).
- **Highest-risk surface**, so: least-privilege **scopes** per management operation, every
  call **audited** (`@pithy-sh/audit`, §10.19), credentials **rotated** (`@pithy-sh/secrets`,
  §10.2), and **per-environment** (§10.3 — a staging control-plane credential never reaches
  production).

10.24 **Cloudflare access standardization: bindings vs REST API.** Two ways to touch
Cloudflare resources; we pick deliberately, never by accident:
- **Inside the Worker request runtime → use bindings** (`env.DB`, `env.SESSIONS`, the Email
  binding, etc.). Bindings are the default: faster, cheaper, no API token, and principle-1
  aligned. They operate the **data plane** on already-provisioned resources.
- **Outside the Worker (CLI, CI, worktree/ephemeral provisioning, the control-plane
  orchestrator — any Node/Bun context) → use the encapsulated CF REST client.** Also use
  REST for **control-plane / provisioning** operations a binding can't do even in a Worker
  (creating D1 databases, managing KV namespaces, deploying/provisioning Workers,
  account-level ops). Authenticated with a **scoped CF API token** (per environment).
- **`@pithy-sh/cloudflare`** is that client — **copied, encapsulated, and standardized from
  the CMS `libs/data-types/src/cloudflare/` managers** (`CloudflareManager` base +
  `CloudflareD1Manager`, `CloudflareKVManager`, `CloudflareWorkersManager`,
  `WorkersProvisioner`, `CloudflareSecretsStoreManager`, `CloudflareTurnstileManager`,
  `D1PreparedStatementREST`, etc.). It wraps the official `cloudflare` SDK and falls back to
  raw `fetch` for endpoints the SDK doesn't cover.
- **Concrete consumers this unblocks:** remote `pithy migrate` for staging/production runs
  Kysely migrations over D1 via **`D1PreparedStatementREST`** (a Kysely D1-REST dialect);
  ephemeral env + worktree provisioning (§10.17/§10.18) use **`WorkersProvisioner`** +
  D1/KV managers to create/destroy per-feature resources. Introduced when first needed
  (remote migrate / provisioning), not in the Phase 0 local-dev path.

10.25 **CF API token automation & bootstrap.** Everything `@pithy-sh/cloudflare` (§10.24)
does needs a credential. We minimize the human bootstrap and automate the rest:
- **Human bootstrap (two one-time steps):** (1) `wrangler login` — interactive OAuth, gives
  wrangler its own auth for `dev`/`deploy`; (2) a single **bootstrap CF API token** placed
  in `.dev.vars` (e.g. `CF_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) that `@pithy-sh/cloudflare`
  uses to call the CF REST API. Document the **least privileges** this seed token needs.
- **Automated, scoped token minting:** from the bootstrap token, `pithy` creates the
  further **scoped, least-privilege API tokens** specific use cases need (ephemeral-env
  provisioning, remote migrate, the control-plane client, etc.) via the CF API — the user
  doesn't hand-craft tokens in the dashboard.
- **Always prefer account-owned (org-level) tokens over user-bound tokens.** Account-owned
  tokens survive a person leaving, are scoped to the account/org, and aren't tied to an
  individual's session. Only fall back to a user token when an operation genuinely has no
  account-owned equivalent.
- **Scope per use case:** each minted token gets exactly the permissions its job requires
  (likely candidates: D1 edit/create, Workers Scripts edit, KV edit — exact set TBD per
  command/capability as built). Minted tokens are **stored + rotated via `@pithy-sh/secrets`
  (§10.2), per environment (§10.3)**, never committed.

10.26 **`pithy dev` — multi-worker local orchestrator (port the CMS `scripts/dev.ts`).** A
Pithy project is several Workers (each lives in `apps/<name>/`, see §10.27), plus any web
frontend; a developer should not hand-juggle terminals and ports. One supervising process
runs them all and ports the proven CMS `dev.ts` design:
- **Worker discovery + the dev set.** `apps/` *is* the registry — `pithy dev` discovers
  Workers by enumerating `apps/*`, no hand-maintained list. Each worker declares whether it
  belongs in the local dev environment via a co-located, Zod-described `dev` block in its
  manifest: `dev.autostart` (must this run for the local env to function?), an optional
  `dev.readySignal` regex (what marks it "ready" in its output — defaults to
  `/Ready on https?:\/\//`; the CMS `dev.ts` hardcoded these, we make them declarative), and
  an optional `dev.preferredPort` hint. `pithy dev` starts exactly the `autostart` workers.
- **Port resolution.** The allocator (§10.18) assigns one port **per autostart worker** in
  the feature's registry entry; `pithy dev` confirms each is free on **both** `127.0.0.1`
  and `::1` (Vite binds IPv6-only, wrangler binds both) and scans forward if something
  external holds it. Resolved ports are exported as env and the cross-worker URLs baked in as
  `*_ORIGIN` dev vars, so workers address each other **directly over localhost** rather than
  through wrangler's flaky cross-`wrangler dev` service registry.
- **Session state + cleanup.** Writes a git-ignored `.dev-state.json` (pid, resolved ports,
  child pids). A re-run stops the previous session first and **reaps orphaned
  `workerd`/`wrangler` processes** still holding the default ports (`lsof` sweep), so a
  crashed session can't block startup.
- **Process-group teardown.** Spawns each child via `setsid` so one `kill(-pgid)` tears down
  the whole `wrangler → workerd` subtree; graceful `SIGTERM` then `SIGKILL` after a grace
  window. Output from every worker is labeled, colorized, and tee'd to terminal +
  `logs/dev.log`; a single "ready" banner fires once all in-scope workers report ready.
- **Parallel features.** Because ports come from the per-feature block (§10.18), several
  worktrees each run `pithy dev` simultaneously without conflict and their workers
  interoperate within each feature. Honors the brand voice for all output (§10.6, principle 7).

10.27 **`pithy worker add <name>` — scaffold a Worker; `apps/` is the registry.** Workers a
project deploys live in `apps/<name>/` (distinct from `packages/*`, the `@pithy-sh/*` library
capabilities). `pithy worker add <name>` scaffolds one — `wrangler.jsonc`, `package.json`, a
mount file, the `.dev.vars` symlink (§10.18), and the co-located `dev` manifest block
(§10.26) — and registers it in the Bun workspace. **The folder is the source of truth:** every
Pithy command that needs the worker set (`dev`, `deploy`, the port allocator) discovers it by
enumerating `apps/*` and reading each worker's manifest, so adding or removing a worker is
just adding or removing its directory. When the autostart set changes, the next
`feature create`/`dev` **reconciles** the feature's port-registry entry — allocating ports for
new autostart workers and freeing ports for removed ones (§10.18). `worker remove`/`worker
list` round out the set; all are agent-drivable (`--json`, non-interactive).

## 11. Open questions deferred to planning

- Exact per-env `wrangler.jsonc` shape and how `pithy deploy` maps to wrangler envs.
- How `pithy migrate` reaches remote D1 for staging/prod — **direction set** (§10.24):
  D1 HTTP API via `@pithy-sh/cloudflare`'s `D1PreparedStatementREST` as a Kysely dialect;
  local dev stays on miniflare. Remaining detail: exact dialect wiring + auth-token sourcing.
- Better Auth table id choices (revisit CMS decisions table-by-table).
- Workflow binding ergonomics in the capability contract (one Workflow per job vs a
  shared dispatcher).
- Shape of the client-facing "environment discovery" the CLI scaffolds (config file vs
  generated constants per env).
- **Table prefix scheme** (§10.16): global `cb_` vs per-capability vs configurable.
- **Ephemeral-env binding injection** (§10.17): how CI gives a preview Worker a per-PR D1
  id (generated `wrangler.jsonc` vs API-driven binding) and how teardown stays reliable
  within D1/KV per-account resource limits — provisioning mechanism set (§10.24:
  `WorkersProvisioner` + D1/KV managers from `@pithy-sh/cloudflare`).
- **Audit storage** (§10.19): KV-with-TTL (CMS model) vs a D1 `audit_log` table vs both;
  retention defaults.
- **Tester management feasibility** (§10.22): what the Play Developer API / TestFlight
  actually allow for programmatic testing-track + tester management — research before
  committing scope.
- **Agent integration surface** (§10.20): which of skills/plugins/MCP to ship first, and
  the exact `--json` schema for agent-driven CLI output.
- **Control-plane credential mechanism** (§10.23): asymmetric customer-registered key vs
  scoped HMAC API key vs OAuth client-credentials; scope taxonomy for management ops.
- **CF token scopes per use case** (§10.25): the exact least-privilege permission set for
  each minted token, the minimal bootstrap-token privileges, and confirming the
  account-owned-token creation API covers every operation we need.
