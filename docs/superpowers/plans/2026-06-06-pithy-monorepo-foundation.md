# Pithy Monorepo Foundation + Core Codecs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Bun monorepo (Turborepo + Biome + TS-7-ready config + Vitest + GitHub Actions CI) and ship `@pithy-sh/core`'s SQLite Zod codecs — the foundational, fully-tested JS↔SQLite conversion layer every later capability depends on.

**Architecture:** A Bun-workspaces monorepo with shared `tooling/` config packages, orchestrated by Turborepo. The first real code is `@pithy-sh/core`'s `sqliteCodecs` module — pure, dependency-light Zod 4 codecs (`SQLiteBoolean`, `SQLiteDate`, `sqliteJson`, `JsonDate`, `IanaTimezone`) ported from the proven CMS implementation, with exhaustive round-trip tests. No barrel exports; direct module imports only.

**Tech Stack:** Bun (install + workspaces + run), Turborepo, Biome, TypeScript (TS-7-ready), Zod 4 (codec API), Vitest, GitHub Actions.

**Scope note:** This is plan 1 of the Phase 0 sequence (see `docs/superpowers/specs/2026-06-05-pithy-foundation-design.md` §8). It produces a building, linting, testing monorepo plus the codec layer. Subsequent plans add the capability contract + migration registry, `createBackend`, and the CLI + starter template.

**Conventions reminder (from CLAUDE.md):** Zod object const and its inferred type share the same name (no `Schema` suffix); codec helpers are PascalCase nouns; ESM only; `bun`/`bunx`, never `npm`/`npx`; tests co-located (`feature.ts` → `feature.test.ts`).

---

### Task 1: Initialize the Bun monorepo root

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `bunfig.toml`

- [ ] **Step 1: Create the root `package.json`**

(`typecheck` is a Turbo script backed by per-package `tsc`, not a dependency — there is intentionally no `typecheck` package.)

```json
{
  "name": "@pithy-sh/monorepo",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.1.0" },
  "workspaces": ["packages/*", "tooling/*", "apps/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "turbo": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
# deps & build
node_modules/
dist/
.turbo/

# bun
bun.lockb

# cloudflare / wrangler
.wrangler/
.dev.vars
.dev.vars.*
!.dev.vars.example

# env & secrets
.env
.env.*
!.env.example

# editor / os
.DS_Store
*.log
coverage/
```

- [ ] **Step 3: Create `bunfig.toml`**

```toml
[install]
# Use exact versions for reproducible CI installs
exact = true
```

- [ ] **Step 4: Install and verify the workspace resolves**

Run: `bun install`
Expected: completes without error and creates `bun.lockb`. (No workspaces exist yet beyond root; this just validates the root manifest.)

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore bunfig.toml bun.lockb
git commit -m "chore: initialize Bun monorepo root"
```

---

### Task 2: Shared TypeScript base config (TS-7 ready)

**Files:**
- Create: `tooling/tsconfig/package.json`
- Create: `tooling/tsconfig/base.json`

- [ ] **Step 1: Create the tsconfig tooling package manifest**

```json
{
  "name": "@pithy-sh/tsconfig",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json"]
}
```

- [ ] **Step 2: Create `tooling/tsconfig/base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true
  }
}
```

These flags enforce the TS-7 readiness rules from CLAUDE.md: `verbatimModuleSyntax` + `isolatedModules` on, ESM only. `namespace`/`const enum`/type-decorators are simply never written.

- [ ] **Step 3: Add the tooling package to the install**

Run: `bun install`
Expected: `@pithy-sh/tsconfig` is linked into the workspace; no errors.

- [ ] **Step 4: Commit**

```bash
git add tooling/tsconfig/package.json tooling/tsconfig/base.json bun.lockb
git commit -m "chore: add shared TS-7-ready tsconfig base"
```

---

### Task 3: Shared Biome config

**Files:**
- Create: `tooling/biome/package.json`
- Create: `tooling/biome/biome.json`
- Create: `biome.json` (root)

- [ ] **Step 1: Create the biome tooling package manifest**

```json
{
  "name": "@pithy-sh/biome-config",
  "version": "0.0.0",
  "private": true,
  "files": ["biome.json"]
}
```

- [ ] **Step 2: Create the shared `tooling/biome/biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignoreUnknown": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always" }
  }
}
```

- [ ] **Step 3: Create the root `biome.json` that extends the shared config**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "extends": ["./tooling/biome/biome.json"]
}
```

- [ ] **Step 4: Verify Biome runs clean on the repo**

Run: `bunx biome check .`
Expected: completes with no errors (no source files yet, so nothing to flag).

- [ ] **Step 5: Commit**

```bash
git add tooling/biome/package.json tooling/biome/biome.json biome.json bun.lockb
git commit -m "chore: add shared Biome config"
```

---

### Task 4: Turborepo pipeline

**Files:**
- Create: `turbo.json`

- [ ] **Step 1: Create `turbo.json` (Turbo 2.x `tasks` schema)**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {}
  }
}
```

- [ ] **Step 2: Verify Turbo is callable**

Run: `bunx turbo run typecheck`
Expected: Turbo runs and reports "No tasks were executed" / 0 packages (no packages define `typecheck` yet). Exit code 0.

- [ ] **Step 3: Commit**

```bash
git add turbo.json
git commit -m "chore: add Turborepo task pipeline"
```

---

### Task 5: Scaffold the `@pithy-sh/core` package

**Files:**
- Create: `packages/@pithy-sh/core/package.json`
- Create: `packages/@pithy-sh/core/tsconfig.json`

- [ ] **Step 1: Create `packages/@pithy-sh/core/package.json`**

No barrel: consumers import direct module paths (`@pithy-sh/core/src/sqliteCodecs`). The `exports` map exposes `./src/*` for in-repo dev, mirroring the CMS convention.

```json
{
  "name": "@pithy-sh/core",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./src/*": "./src/*.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json --emitDeclarationOnly false --noEmit false --outDir dist",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@pithy-sh/tsconfig": "workspace:*",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/@pithy-sh/core/tsconfig.json`**

```json
{
  "extends": "@pithy-sh/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install so the new package + Zod resolve**

Run: `bun install`
Expected: `@pithy-sh/core` linked; `zod@4`, `vitest`, `typescript` installed; no errors.

- [ ] **Step 4: Verify typecheck passes on the empty package**

Run: `bun run --filter @pithy-sh/core typecheck`
Expected: PASS (no files yet → tsc succeeds with nothing to check). If tsc errors on "no inputs", proceed — Task 6/7 add files; you may instead run this after Task 7.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/package.json packages/@pithy-sh/core/tsconfig.json bun.lockb
git commit -m "feat(core): scaffold @pithy-sh/core package"
```

---

### Task 6: Vitest config for `@pithy-sh/core`

**Files:**
- Create: `packages/@pithy-sh/core/vitest.config.ts`

The codecs are pure TypeScript with no Workers runtime dependency, so a plain Vitest (node) environment is correct and fast. Workers-runtime tests (`@cloudflare/vitest-pool-workers`, real D1/KV) arrive with the data-layer plan, where they matter.

- [ ] **Step 1: Create `packages/@pithy-sh/core/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
```

- [ ] **Step 2: Add the coverage provider dependency**

Run: `bun add -D @vitest/coverage-v8 --filter @pithy-sh/core`
Expected: `@vitest/coverage-v8` added to `@pithy-sh/core` devDependencies.

- [ ] **Step 3: Verify Vitest is wired (no tests yet)**

Run: `bun run --filter @pithy-sh/core test`
Expected: Vitest reports "No test files found" and exits 0 (or run after Task 7's first test exists).

- [ ] **Step 4: Commit**

```bash
git add packages/@pithy-sh/core/vitest.config.ts packages/@pithy-sh/core/package.json bun.lockb
git commit -m "chore(core): add Vitest config"
```

---

### Task 7: `SQLiteBoolean` codec (boolean ↔ 0|1)

**Files:**
- Create: `packages/@pithy-sh/core/src/sqliteCodecs.ts`
- Test: `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`

Codec semantics (from the spec §6.2/§6.3): `Schema.parse(dbValue)` runs **decode** (DB → app); `Schema.encode(appValue)` runs **encode** (app → DB). The decode-side input is a **union** (not `z.preprocess`) so the schema stays encode-compatible.

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/sqliteCodecs.test.ts
import { describe, expect, test } from "vitest";
import { SQLiteBoolean } from "./sqliteCodecs";

describe("SQLiteBoolean", () => {
  test("decodes 1 -> true and 0 -> false", () => {
    expect(SQLiteBoolean.parse(1)).toBe(true);
    expect(SQLiteBoolean.parse(0)).toBe(false);
  });

  test("decodes lenient truthy strings/booleans", () => {
    expect(SQLiteBoolean.parse("true")).toBe(true);
    expect(SQLiteBoolean.parse("1")).toBe(true);
    expect(SQLiteBoolean.parse("false")).toBe(false);
    expect(SQLiteBoolean.parse(true)).toBe(true);
  });

  test("encodes true -> 1 and false -> 0", () => {
    expect(SQLiteBoolean.encode(true)).toBe(1);
    expect(SQLiteBoolean.encode(false)).toBe(0);
  });

  test("round-trips app -> db -> app", () => {
    expect(SQLiteBoolean.parse(SQLiteBoolean.encode(true))).toBe(true);
    expect(SQLiteBoolean.parse(SQLiteBoolean.encode(false))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `Cannot find module './sqliteCodecs'` (file not created yet).

- [ ] **Step 3: Write the minimal implementation**

```ts
// packages/@pithy-sh/core/src/sqliteCodecs.ts
import { z } from "zod";

const TRUTHY = [true, 1, "1", "true", "True", "TRUE"] as const;
function isTruthy(val: unknown): boolean {
  return (TRUTHY as readonly unknown[]).includes(val);
}

/**
 * SQLiteBoolean codec: bidirectional boolean ↔ 0|1 for SQLite/D1 storage.
 * decode (DB → app): 0|1|boolean|string → boolean
 * encode (app → DB): boolean → 0|1
 * Input schema is a z.union (not z.preprocess) so the schema stays encode-compatible.
 */
export const SQLiteBoolean = z.codec(
  z.union([z.literal(0), z.literal(1), z.boolean(), z.string()]),
  z.boolean(),
  {
    decode: (input: 0 | 1 | boolean | string): boolean => {
      if (typeof input === "boolean") return input;
      return isTruthy(input);
    },
    encode: (b: boolean): 0 | 1 => (b ? 1 : 0),
  },
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — all 4 `SQLiteBoolean` tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/sqliteCodecs.ts packages/@pithy-sh/core/src/sqliteCodecs.test.ts
git commit -m "feat(core): add SQLiteBoolean codec"
```

---

### Task 8: `SQLiteDate` codec (Date ↔ ms-epoch number)

**Files:**
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.ts`
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`

Stores dates as **ms-epoch numbers**. Lenient decode accepts number/string/Date; values `< 99_999_999_999` are treated as **seconds** and multiplied to ms.

- [ ] **Step 1: Add the failing test**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`:

```ts
import { SQLiteDate } from "./sqliteCodecs";

describe("SQLiteDate", () => {
  test("decodes ms-epoch number -> Date", () => {
    const ms = 1_700_000_000_000;
    expect(SQLiteDate.parse(ms)).toEqual(new Date(ms));
  });

  test("decodes seconds-epoch (< 99_999_999_999) as seconds", () => {
    const seconds = 1_700_000_000;
    expect(SQLiteDate.parse(seconds)).toEqual(new Date(seconds * 1000));
  });

  test("decodes ISO string -> Date", () => {
    expect(SQLiteDate.parse("2026-06-06T00:00:00.000Z")).toEqual(
      new Date("2026-06-06T00:00:00.000Z"),
    );
  });

  test("throws on invalid date string", () => {
    expect(() => SQLiteDate.parse("not-a-date")).toThrow();
  });

  test("encodes Date -> ms-epoch number", () => {
    const d = new Date("2026-06-06T00:00:00.000Z");
    expect(SQLiteDate.encode(d)).toBe(d.getTime());
  });

  test("round-trips app -> db -> app", () => {
    const d = new Date("2026-06-06T12:34:56.000Z");
    expect(SQLiteDate.parse(SQLiteDate.encode(d))).toEqual(d);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `SQLiteDate` is not exported from `./sqliteCodecs`.

- [ ] **Step 3: Add the implementation**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.ts`:

```ts
export const MAX_DATE_INTEGER = 8640000000000000;
const SECONDS_THRESHOLD = 99_999_999_999;

/**
 * SQLiteDate codec: bidirectional Date ↔ number (ms epoch).
 * decode (DB → app): number | string | Date → Date (values < SECONDS_THRESHOLD treated as seconds)
 * encode (app → DB): Date → number (ms)
 */
export const SQLiteDate = z.codec(z.union([z.number(), z.string(), z.date()]), z.date(), {
  decode: (input: number | string | Date): Date => {
    if (input instanceof Date) return input;
    if (typeof input === "string") {
      const d = new Date(input);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid date string: ${input}`);
      return d;
    }
    return input < SECONDS_THRESHOLD ? new Date(input * 1000) : new Date(input);
  },
  encode: (d: Date): number => d.getTime(),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — all `SQLiteBoolean` + `SQLiteDate` tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/sqliteCodecs.ts packages/@pithy-sh/core/src/sqliteCodecs.test.ts
git commit -m "feat(core): add SQLiteDate codec"
```

---

### Task 9: `sqliteJson` codec factory (T ↔ JSON string, validated)

**Files:**
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.ts`
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`

Implements spec §10.8: JSON columns (de)serialize automatically **and validate the payload via the inner Zod schema** before storing / after reading. Decode accepts a JSON string OR an already-parsed value (so `.parse()` works on app objects too).

- [ ] **Step 1: Add the failing test**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`:

```ts
import { sqliteJson } from "./sqliteCodecs";

describe("sqliteJson", () => {
  const Payload = z.object({ a: z.number(), b: z.string() });
  const codec = sqliteJson(Payload);

  test("decodes a JSON string -> validated object", () => {
    expect(codec.parse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  test("decodes an already-parsed object (passthrough)", () => {
    expect(codec.parse({ a: 2, b: "y" })).toEqual({ a: 2, b: "y" });
  });

  test("encodes an object -> JSON string", () => {
    expect(codec.encode({ a: 3, b: "z" })).toBe('{"a":3,"b":"z"}');
  });

  test("rejects a payload that violates the inner schema", () => {
    expect(() => codec.parse('{"a":"not-a-number","b":"x"}')).toThrow();
  });

  test("round-trips app -> db -> app", () => {
    const value = { a: 9, b: "round" };
    expect(codec.parse(codec.encode(value))).toEqual(value);
  });
});
```

Note: the `import { z } from "zod"` already present at the top of the test file (added in Task 7? it is not — add it). Ensure the test file has `import { z } from "zod";` at the top alongside the vitest import. If missing, add it now.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `sqliteJson` is not exported (or a missing `z` import error; fix the import as noted, then it fails on the missing export).

- [ ] **Step 3: Add the implementation**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.ts`:

```ts
/**
 * sqliteJson codec factory: bidirectional T ↔ JSON string for SQLite/D1 storage.
 * decode (DB → app): JSON string OR already-parsed value → T (validated by `schema`)
 * encode (app → DB): T → JSON string
 */
export function sqliteJson<T extends z.ZodType>(schema: T) {
  return z.codec(z.union([z.string(), schema]), schema, {
    decode: (input): z.output<T> => {
      if (typeof input === "string") return JSON.parse(input) as z.output<T>;
      return input as z.output<T>;
    },
    encode: (v): string => JSON.stringify(v),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — `SQLiteBoolean`, `SQLiteDate`, `sqliteJson` all green.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/sqliteCodecs.ts packages/@pithy-sh/core/src/sqliteCodecs.test.ts
git commit -m "feat(core): add sqliteJson codec factory"
```

---

### Task 10: `JsonDate` and `IanaTimezone` codecs

**Files:**
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.ts`
- Modify: `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`

`JsonDate` = Date ↔ ISO string, for use **inside** `sqliteJson` payloads (so nested dates encode back without error). `IanaTimezone` = validated/bounded IANA tz string that coerces invalid input to `undefined` on both directions rather than throwing.

- [ ] **Step 1: Add the failing tests**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.test.ts`:

```ts
import { IanaTimezone, JsonDate } from "./sqliteCodecs";

describe("JsonDate", () => {
  test("decodes ISO string -> Date and encodes Date -> ISO string", () => {
    const iso = "2026-06-06T00:00:00.000Z";
    expect(JsonDate.parse(iso)).toEqual(new Date(iso));
    expect(JsonDate.encode(new Date(iso))).toBe(iso);
  });

  test("round-trips through sqliteJson", () => {
    const Wrapper = z.object({ when: JsonDate });
    const codec = sqliteJson(Wrapper);
    const value = { when: new Date("2026-06-06T01:02:03.000Z") };
    expect(codec.parse(codec.encode(value))).toEqual(value);
  });
});

describe("IanaTimezone", () => {
  test("accepts a valid zone", () => {
    expect(IanaTimezone.parse("America/New_York")).toBe("America/New_York");
  });

  test("coerces invalid/garbage to undefined", () => {
    expect(IanaTimezone.parse("Not/AZone")).toBeUndefined();
    expect(IanaTimezone.parse("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `JsonDate` / `IanaTimezone` not exported.

- [ ] **Step 3: Add the implementation**

Append to `packages/@pithy-sh/core/src/sqliteCodecs.ts`:

```ts
/**
 * JsonDate codec: bidirectional Date ↔ ISO string, for use inside sqliteJson payloads.
 */
export const JsonDate = z.codec(z.union([z.string(), z.number(), z.date()]), z.date(), {
  decode: (input: string | number | Date): Date => {
    if (input instanceof Date) return input;
    if (typeof input === "string") {
      const d = new Date(input);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid date string: ${input}`);
      return d;
    }
    return input < SECONDS_THRESHOLD ? new Date(input * 1000) : new Date(input);
  },
  encode: (d: Date): string => d.toISOString(),
});

export const MAX_TIMEZONE_LENGTH = 64;

export function isValidIanaTimezone(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TIMEZONE_LENGTH) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeIanaTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isValidIanaTimezone(trimmed) ? trimmed : undefined;
}

/**
 * IanaTimezone codec: bounded/validated IANA timezone. Coerces invalid values to
 * `undefined` on BOTH decode and encode rather than throwing.
 */
export const IanaTimezone = z.codec(z.string().nullish(), z.string().optional(), {
  decode: (input) => normalizeIanaTimezone(input),
  encode: (value) => normalizeIanaTimezone(value),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — full `sqliteCodecs` suite green.

- [ ] **Step 5: Verify typecheck passes for the package**

Run: `bun run --filter @pithy-sh/core typecheck`
Expected: PASS — no TS errors.

- [ ] **Step 6: Commit**

```bash
git add packages/@pithy-sh/core/src/sqliteCodecs.ts packages/@pithy-sh/core/src/sqliteCodecs.test.ts
git commit -m "feat(core): add JsonDate and IanaTimezone codecs"
```

---

### Task 11: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

Implements spec §10.12: GitHub Actions + Turbo filtered/affected builds. For this first plan the matrix is simple (single job); affected-only filtering tightens as more packages land.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Biome (lint + format check)
        run: bunx biome ci .

      - name: Typecheck
        run: bun run typecheck

      - name: Test
        run: bun run test

      - name: Build
        run: bun run build
```

- [ ] **Step 2: Validate the workflow locally as far as possible**

Run each CI command locally to confirm they pass before relying on CI:
```bash
bun install --frozen-lockfile
bunx biome ci .
bun run typecheck
bun run test
bun run build
```
Expected: all five succeed. (`bun run build` runs `turbo run build`; `@pithy-sh/core`'s `build` script emits `dist/` via tsc.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions verify pipeline"
```

---

## Self-Review

**1. Spec coverage (this plan's slice of §8 Phase 0 + relevant §10):**
- Bun monorepo + workspaces — Task 1 ✅
- Shared `tooling/` (tsconfig TS-7-ready + Biome) — Tasks 2, 3 ✅
- Turborepo build/cache — Task 4 ✅
- `@pithy-sh/core` scaffold — Task 5 ✅
- Vitest test harness — Task 6 ✅
- Zod codec helpers `SQLiteDate`/`SQLiteBoolean`/`sqliteJson`/`JsonDate`/`IanaTimezone` (§6.2) with round-trip tests (§Testing) — Tasks 7–10 ✅
- JSON column validate-before-store (§10.8) — Task 9 ✅
- GitHub Actions CI with Turbo (§10.12) — Task 11 ✅
- Deferred to later plans (correctly out of this slice): capability contract + manifest, migration registry, `createBackend`/Hono/config/KV, CLI, starter template, `@cloudflare/vitest-pool-workers` Workers-runtime tests. Noted in the scope note.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" left. Every code step shows complete code; every run step shows the command + expected result. Task 1 includes an explicit correction of the stray `typecheck` devDependency so the executor isn't misled.

**3. Type/name consistency:** `SQLiteBoolean`, `SQLiteDate`, `sqliteJson`, `JsonDate`, `IanaTimezone`, `normalizeIanaTimezone`, `isValidIanaTimezone`, `SECONDS_THRESHOLD` are defined once and referenced consistently. `SECONDS_THRESHOLD` is introduced in Task 8 and reused in Task 10's `JsonDate` — ordering is correct (Task 8 precedes Task 10). The Zod naming rule (object/type same name) isn't exercised here since codecs are values-only; it lands in the data-layer plan where table schemas appear. Codec method usage (`.parse()` = decode, `.encode()` = encode) matches the spec §6.3 and the CMS ground-truth implementation.

**Note for the executor on Task 9 import:** the test file must have `import { z } from "zod";` at the top. Add it when you first need `z` in a test (Task 9). If you prefer, add it in Task 7's test file header proactively.
