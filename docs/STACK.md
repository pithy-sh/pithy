# Pithy Technical Stack

> This document locks in the technology choices for the Pithy CLI, monorepo, and tooling. Each choice is paired with the reasoning so a future contributor can understand why it was made and what the alternatives are. For brand and visual identity, see `BRAND.md`. For CLI behavior, see `CLI.md`.

---

## 1. Runtime and language

| Choice | Version | Reason |
|---|---|---|
| Node.js | 22+ LTS (minimum) | Current LTS at launch; native ESM, native `fetch`, native `--experimental-strip-types` available, `node:util` parseArgs. Declared in `package.json` `engines.node`. |
| Bun | 1.3+ (supported but optional for end users) | Pithy is built and developed with Bun internally; published packages also run cleanly on Node 22 so adoption isn't gated behind a Bun install. |
| TypeScript | 7.0+ ready (5.x supported during migration) | TypeScript 7.0 stable shipped January 2026 with the Go-based compiler. Pithy targets TS 7 features and `tsgo` from day one. |
| Module system | ESM only | Modern; no dual-bundle complexity; CLIs especially benefit from going ESM-only. |

### Why Node 22 LTS as the floor, not Node 20

TypeScript 7's `tsgo` requires Node 22+ to run the bundler/compiler. Cloudflare Workers' compatibility surface is at parity with Node 22 features. The shrinking population of users still on Node 20 should be told to upgrade — staying on Node 20 to support them constrains the whole project for a small minority.

### Bun: developer choice, not user requirement

Pithy is built with Bun (it's faster, simpler, and runs TypeScript natively without a transpiler layer). But the published packages must work on Node 22+ as well, because forcing every Pithy user to install Bun would be the kind of opinionated overreach that kills adoption.

Concretely:

- **Internal scripts** (build, test, lint, release) assume Bun. The repo's `package.json` declares `"packageManager": "bun@1.3.x"`.
- **Published packages** in `@pithy-sh/*` are pure ESM with no Bun-specific runtime calls. They run on Node 22+, Bun, Deno (with npm: specifiers), and Cloudflare Workers.
- **Users install via** their preferred package manager. The CLI detects which one (see `CLI.md` Section 5.3) and suggests the matching upgrade command.

### TypeScript 7 readiness

TypeScript 7.0 (Project Corsa) shipped stable in January 2026, written in Go, with about 10x faster type-checking and 30x faster type checking. Pithy targets TS 7 from day one because:

- `tsgo` makes monorepo CI dramatically faster
- Type-checking compatibility with TS 5.x is ~99% — no real migration cost
- The ecosystem (Biome, tsdown, Vitest) is converging on TS 7 native
- Going TS-7-native now avoids a migration later

Caveat: TS 7's emit pipeline is still completing as of mid-2026 (decorators not yet supported, downlevel-emit incomplete). Pithy doesn't use decorators and targets ES2022+ output, so this isn't a blocker.

---

## 2. CLI framework: Citty

[github.com/unjs/citty](https://github.com/unjs/citty)

### Why Citty over Commander, Yargs, Oclif

- **TypeScript-first.** End-to-end type inference for args and subcommands without manual annotations.
- **Fast cold start.** ~50-100ms for hello-world; Commander is closer to 250-400ms, Oclif heavier still. Matters because Pithy's brand is speed.
- **Lazy-loadable subcommands.** Native `() => import('./commands/add')` syntax means commands don't load until invoked. Critical as Pithy grows past 8-10 commands.
- **Customizable help renderer.** Pithy's help has specific styling rules (see `CLI.md` Section 4.3); Citty makes the renderer overridable.
- **Built-in shell completions.** bash, zsh, fish supported out of the box. Commander needs a plugin; CAC doesn't have it.
- **Same maintainers as Nuxt.** The UnJS ecosystem is large, active, and not going anywhere.

### What is UnJS, and why does it matter?

[UnJS](https://unjs.io) is a collection of universal JavaScript utilities built primarily by Pooya Parsa and the Nuxt/Nitro team. It's the toolchain that powers Nuxt, Nitro (the deploy-anywhere server framework), and dozens of other modern dev tools. The philosophy is:

- **Minimal and composable.** Each utility does one thing; most are zero-dep or near-zero-dep.
- **Runtime-agnostic.** Designed to work on Node, Bun, Deno, Workers, and edge runtimes.
- **TypeScript-first.** Strict types, great inference, no `@types/*` package needed.

Notable UnJS packages relevant to Pithy:

| Package | Purpose | Used in Pithy? |
|---|---|---|
| `citty` | CLI framework | **Yes** — primary choice |
| `unbuild` | Library bundler (Rollup-based) | Considered; we picked tsdown for speed |
| `defu` | Deep config merging | **Yes** — for layering user config over defaults |
| `consola` | Pretty terminal logging | No — overkill; plain `console.log` + our `style.ts` is enough |
| `ofetch` | Fetch wrapper with sensible defaults | No — native fetch is fine for our use |
| `h3` | HTTP framework | No — out of scope (we're not building a server runtime) |
| `nitropack` | Deploy-anywhere server framework | No — out of scope |

Picking Citty means you're choosing into the UnJS ecosystem's design philosophy: minimal, composable, runtime-agnostic. The packages compose well together, share conventions, and tend not to surprise you. The downside is smaller ecosystem reach than, say, the Vercel/Next.js orbit — but for a CLI/library project, that's a non-issue.

### What Citty does NOT do (and how to handle it)

Citty's argument schema is intentionally simple. It supports:

```ts
args: {
  capability: { type: 'positional', required: true, description: '...' },
  'dry-run': { type: 'boolean', default: false, description: '...' },
  token: { type: 'string', required: false, alias: 't', description: '...' },
}
```

It does NOT support:

- Mutually exclusive flags (`--remove` XOR `--status`)
- Conditionally required (if `--env=production`, `--token` required)
- Argument groups (either `--name`, or both `--first-name` AND `--last-name`)
- Conditional defaults (if `--env=staging`, default `--region=us-east-1`)

This is by design. Citty keeps the schema flat and readable; complex relationships go in the `run()` function.

### Pattern 0: Named helper utilities (most common cases)

For the four most common cross-arg patterns, ship small reusable helpers. They throw `PithyError` directly, so callers don't need to write the error message each time.

```ts
// src/cli/validate.ts
import { PithyError } from './error';

function flag(k: string): string { return `--${k}`; }
function list(keys: string[]): string { return keys.map(flag).join(', '); }

/** If `when` is set, every key in `required` must also be set. */
export function requireWhen(
  args: Record<string, unknown>,
  when: string,
  required: string[],
): void {
  if (args[when] === undefined) return;
  const missing = required.filter(k => args[k] === undefined);
  if (missing.length > 0) {
    const verb = missing.length === 1 ? 'is' : 'are';
    throw new PithyError(
      `${list(missing)} ${verb} required when ${flag(when)} is provided.`,
      `See \`pithy ${args._?.[0] ?? ''} --help\`.`,
    );
  }
}

/** Exactly one of `keys` must be set — not zero, not two or more. */
export function exactlyOne(
  args: Record<string, unknown>,
  keys: string[],
): void {
  const provided = keys.filter(k => args[k] !== undefined);
  if (provided.length === 0) {
    throw new PithyError(
      `Exactly one of ${list(keys)} is required.`,
      'Pick one.',
    );
  }
  if (provided.length > 1) {
    throw new PithyError(
      `Only one of ${list(keys)} may be provided.`,
      'Pick one.',
    );
  }
}

/** At least one of `keys` must be set; more than one is fine. */
export function atLeastOne(
  args: Record<string, unknown>,
  keys: string[],
): void {
  if (keys.every(k => args[k] === undefined)) {
    throw new PithyError(
      `At least one of ${list(keys)} is required.`,
      'Provide one or more.',
    );
  }
}

/** Either all of `keys` are set, or none of them are — never partial. */
export function allOrNone(
  args: Record<string, unknown>,
  keys: string[],
): void {
  const provided = keys.filter(k => args[k] !== undefined);
  if (provided.length === 0 || provided.length === keys.length) return;
  const missing = keys.filter(k => args[k] === undefined);
  throw new PithyError(
    `${list(missing)} must be provided together with ${list(provided)}, or none of them.`,
    'Provide all or none.',
  );
}
```

Use in a command:

```ts
import { defineCommand } from 'citty';
import { requireWhen, exactlyOne } from '../cli/validate';

export default defineCommand({
  meta: { name: 'deploy', description: 'Deploy to Cloudflare Workers.' },
  args: {
    'api-token':     { type: 'string' },
    'account-id':    { type: 'string' },
    'config-file':   { type: 'string' },
    'inline-config': { type: 'string' },
  },
  async run({ args }) {
    requireWhen(args, 'api-token', ['account-id']);
    exactlyOne(args, ['config-file', 'inline-config']);
    // args are now guaranteed valid
  },
});
```

These four helpers cover the vast majority of cross-arg validation cases. For anything more complex (discriminated unions, refinements, multi-step transformations), drop down to Pattern 2 below.



For one-off checks (mutually exclusive flags, two-way conditionals), inline them in `run()`:

```ts
export default defineCommand({
  meta: { name: 'alias', description: 'Manage the shell shortcut.' },
  args: {
    remove: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
  },
  async run({ args }) {
    if (args.remove && args.status) {
      throw new PithyError(
        '--remove and --status are mutually exclusive.',
        'Pick one.'
      );
    }
    if (args.status) return aliasStatus();
    if (args.remove) return removeAlias();
    return installAlias();
  },
});
```

The `PithyError` is a tiny custom error class that formats according to the brand voice (see Section 3 below).

### Pattern 2: Zod validation (complex cases)

When you have group requirements, conditional fields, or any non-trivial validation, parse with Citty and validate with Zod immediately after:

```ts
import { z } from 'zod';

const DeploySchema = z.object({
  env: z.enum(['staging', 'production']),
  token: z.string().optional(),
  region: z.string().optional(),
  'dry-run': z.boolean().default(false),
}).refine(
  (data) => data.env !== 'production' || !!data.token,
  { message: 'Production deploys require --token.', path: ['token'] }
).refine(
  (data) => data.env !== 'production' || !!data.region,
  { message: 'Production deploys require --region.', path: ['region'] }
);

export default defineCommand({
  meta: { name: 'deploy' },
  args: {
    env: { type: 'string', required: true },
    token: { type: 'string', alias: 't' },
    region: { type: 'string', alias: 'r' },
    'dry-run': { type: 'boolean', default: false },
  },
  async run({ args }) {
    const result = DeploySchema.safeParse(args);
    if (!result.success) {
      throw new PithyError(
        result.error.issues[0].message,
        'See `pithy deploy --help` for the full syntax.'
      );
    }
    return runDeploy(result.data);
  },
});
```

This gives you:

- Full discriminated-union, refinement, and group validation
- Clean error messages with field paths
- TypeScript inference of the validated object inside `runDeploy`
- Reusability — the same schema validates programmatic API calls if Pithy is ever embedded

Zod also unlocks rich validation that maps cleanly to Pithy's domain — checking that capability names are in the allowed set, that env values are one of the known environments, that token strings match the Cloudflare API token format, etc.

### Citty code conventions for Pithy

- Every command is in `src/commands/<name>.ts` and exports `default defineCommand({...})`
- Subcommand registration uses lazy imports (`() => import('./commands/add').then(m => m.default)`)
- Hidden flags (`--pithier`, `--pithiest`) are handled in the root command's `run()`, intercepting `rawArgs` before subcommand dispatch
- All errors throw `PithyError` (or its subclasses); the root error handler formats them via the brand voice rules

---

## 3. Error class: PithyError

**One family, runtime and CLI (#16).** `PithyError` lives in
`@pithy-sh/core/src/error`. It is a real `Error` that **carries** a Zod-validated
`ErrorPayload` — a discriminated union keyed on a namespaced `code`
(`auth/invalid_token`, `core/not_found`, …) with an HTTP `status`, a public `message`, an
optional operator `action`, and an optional internal `detail`. Three fields, three audiences:
`message` is the caller's, `action` is the operator's, `detail` is the throw site's. Each
surface is just an encoder over that one payload:

- **HTTP:** `app.onError(pithyErrorHandler)` → `{ error: HttpError.encode(payload) }` at the
  declared status. The codec's encode side strips `action` and `detail`, so neither an
  operator's remedy nor internal context reaches a client.
- **CLI:** `renderTerminal(payload)` → `message` on line 1 (problem), `action` on line 2 — the
  shape `CLI.md` §3.3 specifies (ANSI red first line, no stack trace; the CLI adds the color via
  `style.ts`). Anything that is **not** a `PithyError` is an unexpected crash, reported with a
  debug hint:

```
Something unexpected happened.
Run with `--verbose` to see the full error, or open an issue at https://github.com/pithy-sh/cli/issues.
```

Thin subclasses (`ValidationError`, `ForbiddenError`, `NotFoundError`, `InternalError`, …) are
sugar that default a member's `code`/`status`. The CLI keeps its `(problem, action)`
ergonomics by constructing a payload — `new InternalError({ message, action })` — rather than a
second class. **Runtime code throws `PithyError`, never plain `new Error`**; every new
capability adds its own namespaced codes (`domain/reason`, aligned with migration namespaces).

**The kit's set is closed; the union is not.** `KitErrorPayload` is the discriminated union above —
the only one anything may switch over exhaustively, and the one every kit code is validated against,
status and all. `ErrorPayload` is that plus one open member, so an adopter declares their own
`domain/reason` codes through `defineErrorPayload` instead of reusing a kit code that means
something else. The kit's domains are reserved — `auth/`, `payments/`, `core/` and the rest are
refused, at the declaration as a type error and again at the parse, which is also what keeps a
capability's own typo a hard failure — and `detail` is stripped from an adopter's errors by the same
codec, on the same path: the boundary is a property of the schema, not of who wrote the code.

Two things the seam cannot carry across. A kit member pins one `status` per `code`; an adopter's is
bounded to 400–599 and no further, so declare each of your codes in one vehicle class and keep the
pinning yourself. And an adopter's code is branded, which is what keeps `payload.code ===
"core/not_found"` narrowing to exactly one kit member — so narrow your own with
`isErrorCode(payload, "connect/device_code_expired")` and type the class with
`ErrorPayloadOf<"connect/device_code_expired">`, never a bare `===`.

---

## 4. Argument validation: Zod

[zod.dev](https://zod.dev)

### Why Zod over Valibot, ArkType, or hand-rolled

- **Ecosystem maturity.** Most TypeScript developers already know it. Reviewers and contributors won't need to learn a new syntax.
- **Bundle size doesn't matter for a CLI.** The Valibot/ArkType bundle-size advantage matters in browsers; in a Node CLI you have a 50-200MB Node binary anyway.
- **Composable with hono, drizzle, openapi tooling.** If/when Pithy capabilities want shared schemas across CLI and runtime, Zod is the lingua franca.
- **Error formatting hooks.** Zod's `.refine()` and `.superRefine()` let you produce error messages already in the brand voice ("Production deploys require --token." not "Validation failed at root.token").

Valibot is technically superior for many cases (smaller, faster, modern API) but Zod's ecosystem dominance wins on a project that wants contributors.

---

## 5. Interactive prompts: @clack/prompts

[github.com/natemoo-re/clack](https://github.com/natemoo-re/clack)

### Why clack over Inquirer, Prompts, Enquirer

- **Single-line spinners and step indicators** that match modern CLI aesthetics. Inquirer's prompts feel dated next to clack.
- **Accessible by default.** Color and contrast handled correctly; gracefully degrades in non-TTY contexts.
- **Cancellation is a first-class concept.** `cancel()` works correctly; `Ctrl+C` produces clean exits rather than hanging.
- **Used by shadcn, create-t3-app, and most polished new CLIs.** Strong social proof.

### Standard usage pattern

```ts
import { intro, outro, text, confirm, select, spinner, cancel, isCancel } from '@clack/prompts';

export async function initCommand() {
  intro('pithy init');

  const projectName = await text({
    message: 'Project name',
    placeholder: 'my-pithy-app',
    defaultValue: 'my-pithy-app',
  });
  if (isCancel(projectName)) { cancel('Cancelled.'); process.exit(0); }

  const installAlias = await confirm({
    message: 'Want a shortcut? Type `p.` instead of `pithy`.',
    initialValue: true,
  });
  if (isCancel(installAlias)) { cancel('Cancelled.'); process.exit(0); }

  const s = spinner();
  s.start('Creating project');
  // ...do work
  s.stop('Created');

  outro(`Done${saffron('.')}`);
}
```

Note the `isCancel` guard on every prompt — that's the clack idiom for handling `Ctrl+C` cleanly. Skip it and your CLI hangs in unexpected ways.

---

## 6. Color layer: picocolors + custom saffron helper

[github.com/alexeyraspopov/picocolors](https://github.com/alexeyraspopov/picocolors)

### Why picocolors over chalk, kleur, or ansi-colors

- **~1KB.** Smallest of the lot.
- **Zero dependencies.** Auditable.
- **Handles `NO_COLOR`, `FORCE_COLOR`, TTY detection automatically.** Don't reinvent.
- **Same API as chalk** for the basic colors (no learning curve).

The custom `saffron()` helper (see `CLI.md` Section 3.4 for full code) wraps picocolors with truecolor support for the brand mark:

```ts
// src/lib/style.ts
import pc from 'picocolors';

const SAFFRON_TC = '\x1b[38;2;212;160;23m';
const SAFFRON_256 = '\x1b[38;5;178m';
const RESET = '\x1b[0m';

export function saffron(text: string): string {
  if (process.env.NO_COLOR || !pc.isColorSupported) return text;
  if (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit') {
    return SAFFRON_TC + text + RESET;
  }
  return SAFFRON_256 + text + RESET;
}

export const { dim, red, yellow, bold } = pc;
```

Every part of the CLI imports color helpers from `src/lib/style.ts` — never directly from picocolors. This keeps the option open to swap libraries later without rewriting every file.

---

## 7. Monorepo: Bun workspaces + Turborepo

### Why Bun for package management

By mid-2026, Bun's package manager has matured enough for production monorepo use. Specifically:

- **Speed.** Bun installs are roughly 4-5x faster than pnpm 10 on cold CI runs, 3x faster on warm cache. For a CI loop you'll run thousands of times, this compounds.
- **Native TypeScript runtime.** Running scripts via `bun run` executes TS directly with no transpiler layer. No `tsx`, no `ts-node`, no separate dev-runtime tool to install or configure.
- **Text-based lockfile.** `bun.lock` (replacing the binary `bun.lockb` in Bun 1.2) is human-readable and diffable, matching the conventions of `pnpm-lock.yaml`.
- **Workspaces native.** First-class workspace filtering, parallel installs, version catalogs.
- **Single tool.** Bun is package manager, runtime, test runner, and bundler. The cognitive surface area is smaller than "pnpm + tsx + tsc + vitest + tsup".

The repo declares Bun as the canonical manager:

```json
// package.json
{
  "packageManager": "bun@1.3.x",
  "engines": { "node": ">=22.0.0", "bun": ">=1.3.0" }
}
```

### What pnpm still does better (and why we're choosing Bun anyway)

Honesty matters here — there are real things pnpm 10 still does better in 2026, even if the user (correctly) sees Bun as the better fit for Pithy:

| pnpm advantage | What it means | Why it doesn't change the decision for Pithy |
|---|---|---|
| **65.5M weekly npm downloads vs Bun's negligible CLI adoption** | Most ecosystem CI examples assume pnpm | Pithy's CI scripts are short and well-documented; this is a one-time learning cost |
| **`pnpm patch`** | Apply ad-hoc patches to dependencies in-tree | Pithy doesn't (and shouldn't) need this; if a dependency needs patching, it should be forked |
| **Strict phantom-dependency prevention** | Imports must be declared in `package.json` | Bun's resolution is less strict, but Biome's import rules cover most of this |
| **More mature workspace protocol support** | `workspace:^` and edge cases more battle-tested | Bun's workspace support handles 99% of cases; the remaining 1% has clear workarounds |
| **`resolutions` field works** | Force a specific version across the tree | Bun uses `overrides` instead — same outcome, different syntax |
| **Universal CI compatibility** | Every CI provider has pnpm-tuned actions | Bun CI tooling is now first-class in GitHub Actions, Vercel, and most providers |
| **Better behavior under `npm publish` edge cases** | Some publish workflows historically tripped on Bun | Resolved in Bun 1.2+; verify in your CI but no longer a blocker |

**Net: if your priorities are install speed, single-tool DX, and native TypeScript execution, Bun wins. If your priorities are ecosystem maximalism, strict reproducibility, and ten years of battle-testing, pnpm wins.** For Pithy, where the brand and DX are explicitly modern/pithy, Bun is the right call. If you regret it, switching to pnpm later is a one-day migration (the lockfile converter handles the package resolution automatically).

### Why Turborepo over Nx, Lerna, plain Bun

- **Caching is the killer feature.** Re-running `turbo build` skips unchanged packages; CI is dramatically faster.
- **Remote caching.** Shared across CI runs and team machines; Vercel hosts a free tier.
- **Simple config.** `turbo.json` is short and readable; Nx is more powerful but heavier and steeper.
- **Bun + Turborepo is a tested combination.** Both projects test integration; no surprises.

### Repo structure (high-level)

The authoritative package roadmap lives in the foundation spec (§4). The set below is what
has shipped, plus what the roadmap still holds — not the full final tree:

```
pithy/
├── apps/
│   └── docs/             # docs site at pithy.sh (framework TBD)
├── packages/
│   ├── cli/              # @pithy-sh/cli — the CLI binary
│   ├── core/             # @pithy-sh/core — runtime primitives, contract, codecs, registry, Workflow seam
│   ├── cloudflare/       # @pithy-sh/cloudflare — encapsulated CF REST client (out-of-Worker)
│   ├── secrets/          # @pithy-sh/secrets — secrets store + key rotation
│   ├── auth/             # @pithy-sh/auth — Better Auth: magic-link/OTP/Google/Apple
│   ├── audit/            # @pithy-sh/audit — audit-trail capability + seam
│   ├── email/            # @pithy-sh/email — CF Email via D1 job table + Workflow
│   ├── turnstile/        # @pithy-sh/turnstile — bot-protection middleware
│   ├── storage/          # @pithy-sh/storage — R2 object store seam, quotas, share links
│   ├── media/            # @pithy-sh/media — media records + AI enrichment, over the store seam
│   ├── vector/           # @pithy-sh/vector — Vectorize index with schema-declared filters
│   ├── leaderboard/      # @pithy-sh/leaderboard — ranking across daily → all-time windows
│   ├── rating/           # @pithy-sh/rating — pluggable skill rating (MMR) + experience (XP)
│   ├── matchmaking/      # @pithy-sh/matchmaking — room codes, invites, friends, matched queues
│   ├── multiplayer/      # @pithy-sh/multiplayer — authoritative turn-based sessions (Durable Objects)
│   ├── ledger/           # @pithy-sh/ledger — per-user balance ledger with holds
│   ├── payments/         # @pithy-sh/payments — Apple/Google/Stripe → one cross-rail entitlement
│   └── testers/          # @pithy-sh/testers — early-access/tester invitations (roadmap)
├── package.json
├── turbo.json
├── CLAUDE.md             # always-loaded agent instructions (points to docs/)
├── README.md
└── docs/                 # BRAND.md, CLI.md, STACK.md + superpowers/{specs,plans}
```

> `jobs` appears elsewhere in this doc as an **illustrative suggestion**. It was never
> designed, and it is retired: durable background work is a core seam
> (`@pithy-sh/core/src/workflow/`) that every capability registers against, not a capability
> of its own. Any other name not in the tree above is illustrative too. The spec's §4
> roadmap governs what ships next.

Bun reads `workspaces` from the root `package.json`; no separate `pnpm-workspace.yaml` equivalent needed.

```json
// root package.json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

The full structure spec (capability manifest schema, template files, etc.) lives in `ARCHITECTURE.md` (forthcoming).

---

## 8. Build tooling: tsdown

[github.com/rolldown/tsdown](https://github.com/rolldown/tsdown)

### Why tsdown over tsup, unbuild, tsc alone, or bun build

- **Rolldown-powered.** Built on Rust-based Rolldown (the Rollup successor) and Oxc for transformations. Substantially faster than esbuild-based tsup for library bundling, particularly on dts generation.
- **Library-specific defaults.** Where Rolldown is a general-purpose bundler, tsdown is preconfigured for library authors: dts generation, multiple output formats, package.json exports validation, automatic bin field detection from shebang lines.
- **Compatible with tsup config.** The migration story is intentionally smooth — if you ever need to switch back, `tsup.config.ts` mostly works as-is.
- **Production proof.** Used by `cloudflare/agents` and a growing list of library projects in 2026. Directly Cloudflare-adjacent, which matters for Pithy's ecosystem.
- **Rolldown is the future of Vite.** Vite is in active migration to Rolldown as its bundler; that means the tool will get sharper, faster, and more compatible over time as the whole Vite ecosystem invests in it.

### The Rolldown context

Rolldown is the Rust rewrite of Rollup, by VoidZero (the company spun out of the Vite team). It's API-compatible with Rollup plugins but written in native code. The performance jump over JavaScript-based bundlers is dramatic — typically 5-15x on library builds, larger on cold starts.

tsdown wraps Rolldown with library-specific defaults so you don't write a Rolldown config yourself. The relationship is similar to tsup-wraps-esbuild: a thin, sensible-defaults layer over a powerful underlying tool.

### Sample config

```ts
// packages/cli/tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,           // CLI doesn't ship type declarations
  // tsdown auto-detects the shebang in cli.ts and writes the bin
  // field in package.json automatically. No banner config needed.
});
```

For library packages (`@pithy-sh/core` and capabilities), the config enables dts:

```ts
// packages/core/tsdown.config.ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: true,
  exports: true,        // Validates and auto-generates package.json exports
});
```

### What about `bun build`?

Bun has its own bundler. It's fast, well-integrated, and you might wonder why we're not just using it. Three reasons:

1. **Library output quality.** `bun build` is excellent for applications and serverless functions but less polished for npm library publication — tree-shaking, dts generation, exports field handling are all weaker than tsdown's.
2. **Toolchain portability.** Using tsdown means anyone can build Pithy on any runtime; using `bun build` would lock the build step to Bun specifically (contradicting our "Bun is optional" rule from Section 1).
3. **The Rolldown bet.** Vite/Rolldown's ecosystem momentum is more durable than Bun's bundler. Long-term, Rolldown-based tooling is where the industry is converging.

If `bun build` improves on library output in 2027+, revisit.

---

## 9. Dev runtime: Bun (native TypeScript execution)

No separate dev-runtime tool is needed. `bun run` executes TypeScript files directly with no transpiler layer or watch tool to install.

```json
{
  "scripts": {
    "dev": "bun run --watch src/cli.ts",
    "dev:debug": "bun --inspect run src/cli.ts"
  }
}
```

This is one of the substantive simplifications Bun provides. The traditional Node-based stack needed `tsx` (or `ts-node`, or `swc-node`) plus a watcher layer; with Bun, that's a single built-in command.

### What about contributors on Node?

If a contributor doesn't have Bun installed and wants to run scripts via Node, they can use `node --experimental-strip-types` on Node 22.6+:

```bash
node --experimental-strip-types src/cli.ts
```

This is documented in `CONTRIBUTING.md` for completeness. The main scripts assume Bun.

---

## 10. Testing: Vitest

[vitest.dev](https://vitest.dev)

### Why Vitest over Jest, node:test, bun:test

- **Same config as Vite/your build tool** if you ever share configs.
- **Fast by default.** Native ESM, parallel execution, smart test isolation.
- **Modern API.** No need for transformers, plugins, or Jest's legacy quirks.
- **Snapshot testing, mocking, coverage** all built in.
- **Works with the Cloudflare Workers runtime** via `@cloudflare/vitest-pool-workers` — important since you'll want to test capabilities against the actual Workers runtime, not a mock.

### Standard test layout

```
packages/cli/
├── src/
│   ├── commands/
│   │   └── add.ts
│   └── lib/
│       └── style.ts
└── test/
    ├── commands/
    │   └── add.test.ts
    └── lib/
        └── style.test.ts
```

Tests live in a sibling `test/` directory mirroring `src/`. Avoid `*.test.ts` colocated with source — keeps source files cleaner and `dist/` outputs simpler.

---

## 11. Linting and formatting: Biome

[biomejs.dev](https://biomejs.dev)

### Why Biome over ESLint + Prettier

- **All-in-one.** Linter, formatter, import sorter — one tool, one config.
- **Rust-fast.** Lints a medium monorepo in well under a second; ESLint takes 5-30 seconds for the same.
- **Zero plugin hell.** No `@typescript-eslint`, no plugin-import, no prettier-eslint conflicts.
- **Active development by Vercel** alums; growing adoption.

### Configuration

`biome.json` at repo root, ~30 lines, covers everything:

```json
{
  "$schema": "https://biomejs.dev/schemas/latest/schema.json",
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "error",
        "useImportType": "error"
      },
      "correctness": {
        "noUnusedImports": "error"
      }
    }
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always" }
  }
}
```

### Caveat: Biome doesn't yet match every ESLint plugin

If you need rules that Biome doesn't have (e.g., advanced React rules, custom plugin lints), ESLint + Prettier is the safe fallback. For Pithy — a CLI and runtime library, no React — Biome's coverage is more than enough. If this becomes a problem later, migrating to ESLint + Prettier is a one-day effort.

---

## 12. Git hooks and commit conventions

Pithy enforces clean commits and clean code on every commit. No exceptions. Lint and format errors must never reach `main`.

### 12.1 Tooling

| Concern | Tool | Why |
|---|---|---|
| Git hook installation | **Husky** | Standard, mature, ~3M weekly downloads, handles cross-platform setup |
| Pre-commit lint/format | **Biome** via `lint-staged` | Check staged files only, not the whole repo on every commit |
| Commit message validation | **commitlint** + `@commitlint/config-conventional` | Enforces the Conventional Commits spec |
| Optional: guided commits | **czg** | Modern alternative to commitizen; prompts for type/scope/description |

### 12.2 The Conventional Commits convention

Every commit message follows the shape:

```
<type>(<scope>)?: <description>

[optional body]

[optional footer(s)]
```

Allowed `<type>` values:

| Type | Used when |
|---|---|
| `feat` | A new feature (capability, command, public API) |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting; no code change |
| `refactor` | Code change that's neither feature nor fix |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests |
| `build` | Build system, deps, tooling |
| `ci` | CI configuration |
| `chore` | Misc maintenance |
| `revert` | Reverts a previous commit |

Pithy-specific `<scope>` values:

- `cli`, `core`, `cloudflare`, `secrets`, `auth`, `audit`, `email`, `turnstile`, `leaderboard`, `testers` — for `@pithy-sh/*` packages (keep in sync with the spec §4 roadmap)
- `docs` — for the docs site
- `brew` — for the Homebrew tap workflow
- `release` — for changeset/version PRs

Examples:

```
feat(cli): add pithy doctor command
fix(auth): handle expired sessions gracefully
docs: clarify Homebrew install instructions
chore(release): bump versions for 1.2.0
feat(cli)!: rename --no-color to --plain (breaking)
```

The `!` after the scope indicates a breaking change (also valid: a `BREAKING CHANGE:` footer in the commit body).

### 12.3 Configuration

`.husky/pre-commit`:
```sh
bun run lint-staged
```

`.husky/commit-msg`:
```sh
bun run commitlint --edit $1
```

`commitlint.config.ts`:
```ts
import type { UserConfig } from '@commitlint/types';

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', [
      'cli', 'core', 'cloudflare', 'secrets', 'auth', 'audit', 'email',
      'turnstile', 'leaderboard', 'testers',
      'docs', 'brew', 'release',
    ]],
    'header-max-length': [2, 'always', 100],
  },
};

export default config;
```

`lint-staged.config.ts`:
```ts
export default {
  '*.{ts,tsx,js,jsx,json,md}': ['biome check --apply'],
};
```

This runs Biome on staged files only, applying safe auto-fixes. If Biome finds errors it can't auto-fix, the commit is rejected.

### 12.4 Why Husky over lefthook or simple-git-hooks

Honest answer: lefthook (Go-based, parallel hook execution) is meaningfully faster than Husky on large repos, and simple-git-hooks has a tiny install footprint. Both are valid alternatives.

Pithy picks Husky because:

- Most contributors recognize it instantly; near-zero learning curve
- Tooling integration is universal — every IDE, every editor, every CI provider knows about Husky
- For a CLI/library monorepo at Pithy's scale (~10 packages), the performance difference is unnoticeable (~50ms vs ~150ms per hook)

If the repo grows past 30+ packages or hook runtime starts hurting CI, switch to lefthook — it's a one-config-file migration.

### 12.5 The non-negotiable rule

A commit that fails `biome check` or `commitlint` is rejected. There is no `--no-verify` escape hatch in normal workflow. CI re-runs both checks on every PR, so a locally-bypassed hook is caught at the latest at PR time.

For maintainers who need to bypass during emergencies (a hotfix that breaks lint temporarily), `git commit --no-verify -m "fix: emergency patch"` works, but must be followed immediately by a cleanup commit. This is documented in `CONTRIBUTING.md` and noted on the PR.

### 12.6 How Conventional Commits interacts with Changesets

Conventional Commits and Changesets serve different purposes:

- **Conventional Commits** standardizes the *commit message* — what's in `git log`
- **Changesets** drives *versioning and changelog generation* — what's in `CHANGELOG.md` and `package.json`

These are separate. Changesets uses `.changeset/*.md` files (created during PRs) to decide which packages bump and which changelog lines they get. The commit message is for humans reading `git log`; the changeset file is for the release pipeline. Both are required.

A typical feature PR therefore contains:

1. The actual code change
2. A `.changeset/*.md` file describing the user-facing change
3. Commits following the Conventional Commits format

The release flow (described in the next section) consumes the changeset files; humans read the commit log.

---

## 13. Release automation: Changesets

[github.com/changesets/changesets](https://github.com/changesets/changesets)

### Why Changesets over semantic-release, release-please

- **Monorepo-native.** Tracks version bumps per package independently — critical for `@pithy-sh/cli` vs `@pithy-sh/auth` vs `@pithy-sh/core` releasing on different cadences.
- **Explicit changelogs.** Contributors write the changelog entry in the PR; CI doesn't have to guess from commit messages.
- **Used by Vercel, Shopify, Cloudflare, dozens of major OSS projects.**
- **Integrates cleanly with Bun + Turborepo.** Established pattern.

### Workflow

1. Contributor adds a changeset to their PR (`bun changeset`)
2. PR merges, GitHub Action opens a "Version Packages" PR with all pending changesets applied
3. Merging the version PR publishes all updated packages to npm
4. Homebrew tap workflow (see `CLI.md` Section 5.4) triggers off the npm publish for `@pithy-sh/cli`

GitHub Action config (`.github/workflows/release.yml`) is straight from the Changesets docs — about 30 lines.

---

## 14. Schema validation in capabilities: Zod (again)

Already chosen in Section 4 for CLI args. Reuse it for capability schemas:

- Auth: validating user records, session payloads
- Storage: validating upload metadata
- Vector: validating metadata filters
- Jobs: validating payload schemas

Shared schemas live in each capability's package (`@pithy-sh/auth` exports its Zod schemas) so consumers can import them for end-to-end type safety.

---

## 15. Summary: what to install

For a fresh setup of the Pithy monorepo:

```bash
# Workspace root — initialize with Bun
bun init -y
bun add -d turbo typescript vitest @biomejs/biome @changesets/cli tsdown \
  husky lint-staged @commitlint/cli @commitlint/config-conventional czg

# Wire up Husky
bunx husky init
echo "bun run lint-staged" > .husky/pre-commit
echo "bun run commitlint --edit \$1" > .husky/commit-msg
chmod +x .husky/pre-commit .husky/commit-msg

# CLI package
cd packages/cli
bun add citty @clack/prompts picocolors zod execa defu

# Capability packages (each one)
bun add zod @cloudflare/workers-types
bun add -d wrangler vitest @cloudflare/vitest-pool-workers
```

Configure the root `package.json`:

```json
{
  "packageManager": "bun@1.3.0",
  "engines": {
    "node": ">=22.0.0",
    "bun": ">=1.3.0"
  },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "lint": "biome check .",
    "format": "biome format --write .",
    "commit": "czg",
    "changeset": "changeset",
    "release": "turbo build && changeset publish"
  }
}
```

That's the entire base stack. Each dependency is a deliberate choice, each documented above.

---

## 16. What we're explicitly NOT using

Useful as a "if you're tempted, here's why we said no" reference.

| Not using | Why |
|---|---|
| Commander | Slower cold start, weaker TypeScript inference, harder help customization |
| Yargs | Heavy, complex API, no longer the best-in-class |
| Oclif | Excellent for mega-CLIs (Heroku, Salesforce) but overkill and heavy for our size |
| Inquirer | Aesthetics feel dated; clack is the modern equivalent |
| chalk | picocolors is smaller and has the same API |
| Jest | Vitest is faster, has a cleaner ESM story, and works with our TS 7 target |
| ESLint + Prettier | Biome is one tool, faster, fewer footguns |
| Lerna | Changesets + Bun + Turborepo is the modern monorepo stack |
| npm / pnpm / yarn for the repo | Bun's speed and native TypeScript are a meaningful DX win; users can still install via any manager |
| Bun-only for end users | Users install with whatever they want (npm/pnpm/bun/brew); our published packages run on Node 22+ |
| node:test | Vitest's DX is meaningfully better; runtime perf is similar |
| tsx / ts-node | Bun runs TypeScript natively; no transpiler layer needed in dev |
| Nx | More powerful than Turborepo but heavier; we don't need its full feature set |
| tsup | tsdown is faster (Rolldown vs esbuild), library-first defaults, drop-in compatible |
| unbuild | Strong alternative; we picked tsdown for raw speed and Cloudflare ecosystem traction (cloudflare/agents) |
| `bun build` | Excellent for apps, weaker for npm library publication; toolchain portability matters |
| `semantic-release` | Changesets is more controllable for monorepos with per-package versioning |
| lefthook | Faster than Husky but smaller ecosystem; revisit if hook runtime hurts |
| simple-git-hooks | Tiny but lacks the IDE/CI integrations we want |

---

## 17. Dependency floors

**A published floor decides what every adopter resolves.** That is the whole reason this section exists.
A caret range is a floor, not a pin — an adopter with an old lockfile, a constrained resolver, or a
sibling dependency pulling the range down lands on the bottom of it. So a floor sitting inside an
advisory range is a vulnerability handed to people who never chose it, whether or not the kit's own
code touches the vulnerable path.

Set before the first release, in #397. The survey and the reasoning are on that issue.

### Audit the floors, not the lockfile

`bun audit` reads the **lockfile** — the versions *we* resolved. An adopter has neither our lockfile
nor our resolution, and lands wherever their own resolver puts them, which for a caret range can be
the bottom. So a green `bun audit` in this repo says nothing about what a floor hands out. The two
questions are different and only one of them was being asked.

**Ask the other one directly.** Take every caret range this repo publishes, strip the caret to pin
each at its own minimum, install that, and audit it:

```
# every published floor, pinned to its floor, in a scratch project
bun install && bun audit
```

Run before the first release, that check reported **36 vulnerabilities — 2 critical, 16 high, 14
moderate, 4 low** against a lockfile audit of 5. Four floors accounted for all of the difference,
and **none of them moved a version we install** — every one was already resolving above its own floor,
so the fix is a declaration change with no behaviour change at all:

| Floor | Was | Now | What the old floor handed an adopter |
|---|---|---|---|
| `handlebars` (`@pithy-sh/email`, runtime) | `^4.7.8` | **`^4.7.9`** | The advisory range is `>=4.0.0 <=4.7.8`. The floor sat exactly on its top: 1 critical and 4 high, including JavaScript injection via AST type confusion. `4.7.9` is the only fixed release. |
| `js-base64` (`@pithy-sh/cloudflare`, runtime) | `^3.7.0` | **`^3.9.2`** | `js-base64@3.7.0` declares **`mocha` as a runtime dependency** — an upstream packaging fault, fixed later — dragging `nanoid`, `minimatch`, `js-yaml`, `serialize-javascript` and `diff` into an adopter's tree with fourteen advisories between them. `3.9.2` has no dependencies at all. |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | `^3.700.0` | **`^3.1111.0`** | `fast-xml-parser <5.7.0` — 1 critical, 2 high — plus `@smithy/config-resolver` and `uuid`. |

At the corrected floors the same check reports **5**: the `undici` set below, which no floor of ours
can move.

**The rule this leaves behind.** A floor is a security decision, so it is stated as the lowest version
that is *safe*, not the lowest version that *works*. Where those differ, safety wins and the reason is
written down. Re-run the floor audit whenever a floor changes — a lockfile audit will not catch it.

### Hono: the exposure is the floor, not our usage

`hono` is declared in seventeen packages and in the starter template, at **`^4.13.2`**.

Seven advisories apply below `4.12.34`, and the serious ones are `hono/jsx` not isolating context per
request and `memo()` retaining SSR output — both cross-user data disclosure — plus SSR XSS via `cx()`
and ReDoS in the CORS middleware.

**None of them applies to the kit's own code.** There is no `hono/jsx`, `hono/css`, `hono/cors`,
`hono/proxy` or `hono/language` anywhere in `packages/*/src`; the one `memo(` in
`cloudflare/src/client/clients.ts` is our own helper, unrelated to Hono's.

That is not the point. **An adopter composing `hono/cors` or `hono/jsx` in their own Worker resolves
Hono through our floor**, and gets whatever the bottom of the range gives them. `4.13.2` clears all
seven. Do not lower it because a grep says we are clean — the grep is about us.

### `@types/node` stays on 22.x

`^22.20.1`, never 26. `CLAUDE.md` and §1 above set a **Node 22 LTS floor**; moving the types past it
contradicts a stated constraint rather than satisfying it.

### `miniflare` stays on 4.x, and `@cloudflare/vitest-pool-workers` is held with it

`miniflare` 5 is published only as `5.x-alpha`, and #388 settled the compatibility-date story on 4.x.
A first release does not ship on an alpha dependency.

**These two are one decision, not two.** `@cloudflare/vitest-pool-workers` moved to the miniflare 5
alpha line at **0.20.0** and has not come back: every version from 0.20.0 to 0.21.3 pins an exact
`miniflare@5.x-alpha`. So taking the pool-workers major *is* taking the alpha. The declared
`^0.19.0` caret enforces the exclusion on its own — for a `0.x` package it resolves `<0.20.0` — which
is why no pin is needed to hold it.

Revisit both together, the day miniflare 5 has a stable release. Re-checked against the registry for
#402: `miniflare`'s `latest` dist-tag is still `5.20260811.1-alpha`, there is no stable 5.x, and every
`@cloudflare/vitest-pool-workers` from 0.20.0 to 0.21.3 still pins an exact miniflare 5 alpha. The
top of the 4.x line is `4.20260730.0`, which is what we resolve.

### `@babel/parser` stays on 7.x

`^7.29.8` in `packages/cli`, dev-only, used by one test — the Workflow determinism gate in
`src/ci/workflowDeterminism.test.ts`. **8.x cannot parse the kit.**

`@babel/parser@8` fails on an `async` arrow with a return type annotation inside an object literal
inside a parenthesised expression. Reduced:

```ts
const o = { ...(d ? { m: async (): Promise<void> => f() } : {}) };
//                                ^ SyntaxError: Unexpected token, expected "," (1:33)
```

Babel 7.29.8 parses it. 8.0.0 and 8.0.4 both fail, with `plugins: ["typescript"]` alone, so it is not
a plugin-configuration change. Drop the `async` or drop the return type and 8 parses it; keep both
inside the parentheses and it does not. The kit hits it at
`packages/core/src/migrations/batch.ts:207` — one file out of 1018 — and a parser that cannot read the
tree cannot gate it. 8.x also raises the Node floor to `^22.18.0 || >=24.11.0`.

Filed as #403. Revisit when that reduction parses.

### `undici`: the one advisory we cannot close, and why

`bun audit` reports five undici advisories (`>=7.0.0 <7.29.0`), reached through `miniflare`. One is
high: cross-user information disclosure via degenerate private cache directives.

**No floor of ours can move it.** Every `miniflare` 4.x release pins `undici` at exactly `7.28.0` —
not a range — so there is no 4.x version that resolves a patched undici. Only `miniflare@5.x-alpha`
pins `7.29.0`, and that is the alpha excluded above.

What bounds it: miniflare is the local simulator behind `pithy dev` and the Workers test pool. It is
**not in any deployed Worker** — a deployed Worker runs on workerd, which does not use undici. The
exposure is a developer's own machine running their own dev server, and the advisories are
HTTP-client and cache-directive faults that need an attacker-controlled upstream to reach.

Accepted, not ignored. It closes when miniflare 5 stabilises, which is the same revisit as above.

### `@cloudflare/workers-types` is held at `5.20260729.1`

Held by an `overrides` entry in the root `package.json`, while the declared ranges stay `^5.20260729.1`
so **adopters are not constrained by our tooling problem** — they are not affected by this.

**`5.20260807.2` added `declare const Buffer: any;`** — not `5.20260816.1`, which is where #402 first
noticed it. **`5.20260804.1` is the last clean release**, and every release since carries the line.
`@types/node` declares `var Buffer: BufferConstructor`, and a `var` merges where a block-scoped
`const` does not. With `skipLibCheck` off, TypeScript says it plainly:

```
@cloudflare/workers-types/index.d.ts(486,15): error TS2451: Cannot redeclare block-scoped variable 'Buffer'.
@types/node/buffer.buffer.d.ts(356,19):       error TS2451: Cannot redeclare block-scoped variable 'Buffer'.
```

The redeclaration discards `@types/node`'s `declare global { … }` block in `buffer.buffer.d.ts`, so
the `Buffer` interface loses its own members and falls back to `Uint8Array`'s: `randomBytes(8).toString`
resolves to `() => string`, and `randomBytes(8).toString("hex")` becomes *"Expected 0 arguments, but
got 1"*. `skipLibCheck: true` hides the `TS2451` and leaves only the confusing downstream error, which
is why this reads as a mystery rather than a redeclaration.

It breaks any project listing both `@cloudflare/workers-types` and `node` in `types` — which
`packages/cli` must do, because it is a Node program that type-checks against capability packages
using `D1Database` and `KVNamespace` globals. **Reordering `types` does not help**, verified both ways.
Lifting the override puts three real errors into `packages/cli` (`dev/logging.ts`, `devSecrets/edit.ts`,
`project/atomic.ts`), so the pin is load-bearing, not defensive.

The same release also added `declare const process: any;`, which collides with `@types/node`'s
`var process` in exactly the same way. It causes no error only because `any` absorbs every member
access — it silently degrades `process` to `any` rather than breaking. Worth knowing when the
override lifts.

**Adopters are unaffected, and this was checked rather than assumed.** A project scaffolded by
`pithy init` keeps the two `types` arrays disjoint — `apps/api/tsconfig.json` lists
`["@cloudflare/workers-types"]`, `tsconfig.tools.json` lists `["node"]`, and no project lists both.
A real scaffold type-checks clean against `5.20260816.1` under both `tsc` 5.9.3 and `tsgo` 7.0.2; add
`"node"` to the Worker's `types` and it fails immediately with the same `TS2554`. So the split holds:
**pinned for us, open for them.** Lift the override once upstream declares `Buffer` mergeably, or drops it.

### `postal-mime` is at `^3.0.0`, and that is a security bump

It parses inbound mail from the open internet, so it is the highest-value dependency here to be
current on. 3.0.0 resolves duplicated single-value headers **first**-wins; 2.7.x resolved them
last-wins, which meant a sender could append a second `From:` below their own headers and choose the
address `@pithy-sh/support` recorded as the sender. See
`packages/support/src/mime/parse.test.ts`, *"a second From below the first does not become the
sender"* — the test fails under 2.7.6 and passes under 3.0.0.

---

## 18. Decisions still open

Things to revisit at specific moments:

| Decision | Revisit when... |
|---|---|
| **Docs framework** | TBD — newer framework will be picked later. Deliberately not locked in. |
| Husky vs lefthook | Hook runtime exceeds ~500ms total or monorepo grows past 30+ packages |
| Citty vs Oclif | We seriously commit to `pithy plugin` as a marketplace; Oclif's plugin architecture is mature |
| Bun for the dev workflow | If Bun's edge cases ever start costing us more than the speed saves — revisit pnpm 10 |
| tsdown vs unbuild | If we end up using more UnJS packages and want tighter ecosystem coherence — unbuild is the natural sibling |
| `bun build` for the CLI | Reassess in 2027+ if library output quality improves |
| Self-update command (`pithy self-update`) | Suggesting installer commands works for v1; revisit if users complain |

Otherwise, the choices in this document are committed for v1.
