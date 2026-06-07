# Pithy `createBackend` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runtime that assembles capabilities into a deployable Worker: a config loader, fail-fast binding validation, a typed KV helper, the Kysely `PithyDatabase` builder, and `createBackend` — the Hono app factory that mounts capabilities and serves `/health`.

**Architecture:** `createBackend(capabilities, app)` returns a Hono app (a valid Worker `fetch` handler). Because Cloudflare bindings (`env`) are only available **per-request**, "fail-fast binding validation" is implemented as a memoized first-request middleware (not module-load time). Pure logic (config compose, binding validation, the `PithyDatabase` type) is unit-tested in node; KV/D1/Hono behavior is tested in the real Workers runtime via `@cloudflare/vitest-pool-workers` with Miniflare D1+KV.

**Tech Stack:** Hono, Kysely + kysely-d1 (D1Dialect + CamelCasePlugin), Zod 4, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, Wrangler (dev dep).

**Prerequisites:** Plans 1 and 2 complete (`@pithy-sh/core` has codecs, `BindingSpec`, `AuthContext`, `Capability`, migration registry, manifest).

**Conventions:** Zod object const + type share names; **every Zod field + object/enum has a `.describe()`** (spec §6.8); ESM only; no barrels; `bunx`/`bun run`; tests co-located. **Naming:** Workers-runtime tests use the suffix `*.workers.test.ts`; pure tests use `*.test.ts`.

---

### Task 1: Add runtime + Workers-test dependencies

**Files:**
- Modify: `packages/@pithy-sh/core/package.json`
- Modify: `packages/@pithy-sh/core/tsconfig.json`

- [ ] **Step 1: Add the dependencies**

```bash
bun add kysely-d1@^0.3.0 --filter @pithy-sh/core
bun add -D @cloudflare/workers-types@^4.20240909.0 @cloudflare/vitest-pool-workers@^0.5.0 wrangler@^3.78.0 --filter @pithy-sh/core
```
Expected: `kysely-d1` in dependencies; the rest in devDependencies. (If a version is unavailable, install `@latest` and pin what resolves.)

- [ ] **Step 2: Make Workers types available to the package**

Edit `packages/@pithy-sh/core/tsconfig.json` to add the Workers types:

```json
{
  "extends": "@pithy-sh/tsconfig/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Verify install + existing tests still pass**

Run: `bun install && bun run --filter @pithy-sh/core test`
Expected: install clean; all prior tests (codecs, bindings, authContext, capability, registry, manifest) still PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/@pithy-sh/core/package.json packages/@pithy-sh/core/tsconfig.json bun.lockb
git commit -m "chore(core): add kysely-d1 + Workers test deps"
```

---

### Task 2: Config loader (compose + validate capability config)

**Files:**
- Create: `packages/@pithy-sh/core/src/config.ts`
- Test: `packages/@pithy-sh/core/src/config.test.ts`

Each capability contributes a Zod `config`; the loader composes them into one object keyed by capability name and validates the user's input (spec §7 "Zod-validated config loader").

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/config.test.ts
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";
import { composeConfig, loadConfig } from "./config";

const auth = defineCapability({
  name: "auth",
  config: z.object({ providers: z.array(z.string()) }),
  requiredBindings: [],
});
const turnstile = defineCapability({
  name: "turnstile",
  config: z.object({ siteKey: z.string() }),
  requiredBindings: [],
});
const noConfigCap = defineCapability({ name: "audit", requiredBindings: [] });

describe("composeConfig / loadConfig", () => {
  test("composes only capabilities that declare config", () => {
    const schema = composeConfig([auth, turnstile, noConfigCap]);
    const shape = Object.keys(schema.shape);
    expect(shape).toEqual(["auth", "turnstile"]);
  });

  test("loadConfig validates and returns typed config", () => {
    const cfg = loadConfig([auth, turnstile], {
      auth: { providers: ["magic-link"] },
      turnstile: { siteKey: "k" },
    });
    expect(cfg.auth.providers).toEqual(["magic-link"]);
  });

  test("loadConfig throws on invalid config", () => {
    expect(() => loadConfig([auth], { auth: { providers: "nope" } })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/config.ts
import { z } from "zod";
import type { Capability } from "./capability";

/** Compose each capability's config schema into one object keyed by capability name. */
export function composeConfig(capabilities: Capability[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const cap of capabilities) {
    if (cap.config) shape[cap.name] = cap.config;
  }
  return z.object(shape);
}

/** Validate raw config input against the composed schema; throws on mismatch. */
export function loadConfig(
  capabilities: Capability[],
  input: unknown,
): Record<string, unknown> {
  return composeConfig(capabilities).parse(input) as Record<string, unknown>;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/config.ts packages/@pithy-sh/core/src/config.test.ts
git commit -m "feat(core): add config loader"
```

---

### Task 3: Fail-fast binding validation

**Files:**
- Create: `packages/@pithy-sh/core/src/validateBindings.ts`
- Test: `packages/@pithy-sh/core/src/validateBindings.test.ts`

Pure function over an env record + required `BindingSpec[]`. Used by the first-request middleware in `createBackend` (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// packages/@pithy-sh/core/src/validateBindings.test.ts
import { describe, expect, test } from "vitest";
import { validateBindings } from "./validateBindings";

describe("validateBindings", () => {
  test("passes when all required bindings are present", () => {
    expect(() =>
      validateBindings({ DB: {}, SESSIONS: {} }, [
        { type: "d1", name: "DB", optional: false },
        { type: "kv", name: "SESSIONS", optional: false },
      ]),
    ).not.toThrow();
  });

  test("throws listing every missing required binding", () => {
    expect(() =>
      validateBindings({ DB: {} }, [
        { type: "d1", name: "DB", optional: false },
        { type: "kv", name: "SESSIONS", optional: false },
        { type: "email", name: "EMAIL", optional: false },
      ]),
    ).toThrow(/Missing required bindings: kv:SESSIONS, email:EMAIL/);
  });

  test("ignores optional bindings", () => {
    expect(() =>
      validateBindings({}, [{ type: "kv", name: "CACHE", optional: true }]),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/validateBindings.ts
import type { BindingSpec } from "./bindings";

/** Throw a clear error if any non-optional binding is absent from `env`. */
export function validateBindings(env: Record<string, unknown>, required: BindingSpec[]): void {
  const missing = required
    .filter((b) => !b.optional && env[b.name] == null)
    .map((b) => `${b.type}:${b.name}`);
  if (missing.length > 0) {
    throw new Error(`Missing required bindings: ${missing.join(", ")}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/validateBindings.ts packages/@pithy-sh/core/src/validateBindings.test.ts
git commit -m "feat(core): add fail-fast binding validation"
```

---

### Task 4: Workers-runtime test harness (vitest-pool-workers)

**Files:**
- Modify: `packages/@pithy-sh/core/vitest.config.ts`
- Create: `packages/@pithy-sh/core/vitest.workers.config.ts`
- Create: `packages/@pithy-sh/core/vitest.workspace.ts`
- Create: `packages/@pithy-sh/core/src/cloudflare-test.d.ts`

Set up two Vitest projects: node (pure logic) and Workers (real D1/KV via Miniflare). This task wires the harness; Tasks 5–7 use it.

> Verification note: `@cloudflare/vitest-pool-workers` config API is versioned. If `defineWorkersConfig`/`poolOptions` shapes differ from below, consult the **wrangler** skill (it biases to current Cloudflare docs) and adjust. The intent — Miniflare D1 binding `DB` + KV binding `SESSIONS`, including only `*.workers.test.ts` — must hold.

- [ ] **Step 1: Exclude Workers tests from the node config**

Replace `packages/@pithy-sh/core/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workers.test.ts", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.workers.test.ts"],
    },
  },
});
```

- [ ] **Step 2: Create the Workers config**

```ts
// packages/@pithy-sh/core/vitest.workers.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["src/**/*.workers.test.ts"],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          kvNamespaces: ["SESSIONS"],
        },
      },
    },
  },
});
```

- [ ] **Step 3: Create the Vitest workspace so `vitest run` runs both projects**

```ts
// packages/@pithy-sh/core/vitest.workspace.ts
export default ["./vitest.config.ts", "./vitest.workers.config.ts"];
```

- [ ] **Step 4: Declare the test env bindings type**

```ts
// packages/@pithy-sh/core/src/cloudflare-test.d.ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SESSIONS: KVNamespace;
  }
}
```

- [ ] **Step 5: Verify both projects are discovered (node still green; workers project finds no tests yet)**

Run: `bun run --filter @pithy-sh/core test`
Expected: node tests PASS; the Workers project reports no `*.workers.test.ts` files yet (exit 0). If the runner errors on the pool config, fix per the verification note above before proceeding.

- [ ] **Step 6: Commit**

```bash
git add packages/@pithy-sh/core/vitest.config.ts packages/@pithy-sh/core/vitest.workers.config.ts packages/@pithy-sh/core/vitest.workspace.ts packages/@pithy-sh/core/src/cloudflare-test.d.ts
git commit -m "test(core): add Workers-runtime test harness"
```

---

### Task 5: Typed KV helper

**Files:**
- Create: `packages/@pithy-sh/core/src/kv.ts`
- Test: `packages/@pithy-sh/core/src/kv.workers.test.ts`

Typed access only (spec KV rules): validate values with a Zod object on read+write, namespaced keys per capability, explicit TTLs.

- [ ] **Step 1: Write the failing Workers test**

```ts
// packages/@pithy-sh/core/src/kv.workers.test.ts
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { TypedKv } from "./kv";

const Session = z.object({ userId: z.string(), createdAt: z.number() });

describe("TypedKv", () => {
  test("put validates and get parses, with namespaced keys", async () => {
    const kv = new TypedKv(env.SESSIONS, Session, "auth:session");
    await kv.put("abc", { userId: "u1", createdAt: 123 });

    // stored under the namespaced key
    const raw = await env.SESSIONS.get("auth:session:abc");
    expect(raw).not.toBeNull();

    const value = await kv.get("abc");
    expect(value).toEqual({ userId: "u1", createdAt: 123 });
  });

  test("get returns null for a missing key", async () => {
    const kv = new TypedKv(env.SESSIONS, Session, "auth:session");
    expect(await kv.get("missing")).toBeNull();
  });

  test("put rejects an invalid value", async () => {
    const kv = new TypedKv(env.SESSIONS, Session, "auth:session");
    // @ts-expect-error invalid shape on purpose
    await expect(kv.put("bad", { userId: 1 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `Cannot find module './kv'` in the Workers project.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/kv.ts
import type { z } from "zod";

export interface KvPutOptions {
  /** Explicit TTL in seconds. KV writes should always set this deliberately. */
  expirationTtl?: number;
}

/**
 * Typed KV access: Zod-validated on read and write, with a capability-namespaced key
 * prefix (e.g. "auth:session"). No untyped JSON.parse anywhere else.
 */
export class TypedKv<T extends z.ZodTypeAny> {
  constructor(
    private readonly ns: KVNamespace,
    private readonly schema: T,
    private readonly prefix: string,
  ) {}

  private key(id: string): string {
    return `${this.prefix}:${id}`;
  }

  async get(id: string): Promise<z.output<T> | null> {
    const raw = await this.ns.get(this.key(id), "json");
    if (raw == null) return null;
    return this.schema.parse(raw) as z.output<T>;
  }

  async put(id: string, value: z.input<T>, opts?: KvPutOptions): Promise<void> {
    const validated = this.schema.parse(value);
    await this.ns.put(this.key(id), JSON.stringify(validated), opts);
  }

  async delete(id: string): Promise<void> {
    await this.ns.delete(this.key(id));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — TypedKv Workers tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/kv.ts packages/@pithy-sh/core/src/kv.workers.test.ts
git commit -m "feat(core): add typed KV helper"
```

---

### Task 6: Kysely `PithyDatabase` builder + integration round-trip

**Files:**
- Create: `packages/@pithy-sh/core/src/db.ts`
- Test: `packages/@pithy-sh/core/src/db.workers.test.ts`

A master Zod map → the Kysely interface is its `z.input` (row) side, with `id: number` mapped to `Generated<number>`. Built with `D1Dialect` + the mandatory `CamelCasePlugin`. The Workers test proves the full loop: migrate a table, encode an app object via codecs, insert, read back, decode.

- [ ] **Step 1: Write the failing Workers test**

```ts
// packages/@pithy-sh/core/src/db.workers.test.ts
import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate } from "./sqliteCodecs";
import { createDatabase } from "./db";

// One table = one schema with codecs inline (spec §6.1). camelCase fields; snake_case columns.
const Widget = z.object({
  id: z.number(),
  name: z.string(),
  isActive: SQLiteBoolean,
  createdAt: SQLiteDate,
});
type Widget = z.output<typeof Widget>;

const PithyDatabaseMap = z.object({ widgets: Widget });

beforeAll(async () => {
  // CamelCasePlugin maps createdAt -> created_at etc.; create the snake_case table directly.
  await env.DB.exec(
    "CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_active INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  );
});

describe("createDatabase", () => {
  test("round-trips an app object through codecs + Kysely + CamelCasePlugin", async () => {
    const db = createDatabase(env.DB, PithyDatabaseMap);
    const when = new Date("2026-06-06T00:00:00.000Z");

    // write: encode app -> row, insert
    const record = Widget.encode({ id: 0, name: "w1", isActive: true, createdAt: when });
    // omit the auto-generated id on insert
    const { id: _ignored, ...insertable } = record as { id: number } & Record<string, unknown>;
    await db.insertInto("widgets").values(insertable).execute();

    // read: select row, decode -> app
    const row = await db.selectFrom("widgets").selectAll().executeTakeFirstOrThrow();
    const widget = Widget.parse(row);

    expect(widget.name).toBe("w1");
    expect(widget.isActive).toBe(true);
    expect(widget.createdAt).toEqual(when);
    expect(typeof widget.id).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/@pithy-sh/core/src/db.ts
import { CamelCasePlugin, type Generated, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { z } from "zod";

/** Map a row type's numeric `id` to Kysely's Generated<number> (optional on insert). */
type WithGeneratedId<T> = T extends { id: number }
  ? Omit<T, "id"> & { id: Generated<number> }
  : T;

/** Kysely Database interface derived from the master Zod map's input (row) side. */
export type DatabaseSchema<M extends z.ZodObject<z.ZodRawShape>> = {
  [K in keyof z.input<M>]: WithGeneratedId<z.input<M>[K]>;
};

/**
 * Construct the typed Kysely instance over D1. The Zod map is accepted for type inference;
 * CamelCasePlugin is mandatory (camelCase in TS, snake_case columns).
 */
export function createDatabase<M extends z.ZodObject<z.ZodRawShape>>(
  d1: D1Database,
  _map: M,
): Kysely<DatabaseSchema<M>> {
  return new Kysely<DatabaseSchema<M>>({
    dialect: new D1Dialect({ database: d1 }),
    plugins: [new CamelCasePlugin()],
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — db round-trip green. (If `env.DB.exec` multi-statement rules bite, keep it a single CREATE statement as written.)

- [ ] **Step 5: Commit**

```bash
git add packages/@pithy-sh/core/src/db.ts packages/@pithy-sh/core/src/db.workers.test.ts
git commit -m "feat(core): add Kysely PithyDatabase builder"
```

---

### Task 7: `createBackend` — the Hono app factory

**Files:**
- Modify: `packages/@pithy-sh/core/src/capability.ts` (extend `PithyVars`)
- Create: `packages/@pithy-sh/core/src/createBackend.ts`
- Test: `packages/@pithy-sh/core/src/createBackend.workers.test.ts`

Assembles capabilities into a Hono app: serves `/health`, validates required bindings on first request (memoized — `env` is per-request in Workers), composes middleware, mounts routes, and defaults `c.var.auth` to `null`.

- [ ] **Step 1: Extend `PithyVars` to carry db/kv handles**

In `packages/@pithy-sh/core/src/capability.ts`, replace the `PithyVars` interface with:

```ts
export interface PithyVars {
  auth: import("./authContext").AuthContext | null;
}
```

with:

```ts
export interface PithyVars {
  auth: import("./authContext").AuthContext | null;
  /** Per-request handles populated by createBackend; capabilities read these. */
  db: unknown | null;
  kv: Record<string, KVNamespace> | null;
}
```

(`db` is `unknown | null` here to avoid coupling the contract to a specific table map; capabilities cast to their `Kysely<DatabaseSchema<...>>`. Refine in a later phase if a shared map is introduced.)

- [ ] **Step 2: Write the failing Workers test**

```ts
// packages/@pithy-sh/core/src/createBackend.workers.test.ts
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability";
import { createBackend } from "./createBackend";

describe("createBackend", () => {
  test("serves GET /health", async () => {
    const app = createBackend({ capabilities: [] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("mounts a capability's routes", async () => {
    const ping = defineCapability({
      name: "ping",
      requiredBindings: [],
      routes: (a) => {
        a.get("/ping", (c) => c.text("pong"));
      },
    });
    const app = createBackend({ capabilities: [ping] });
    const res = await app.request("/ping", {}, env);
    expect(await res.text()).toBe("pong");
  });

  test("fails fast with a clear error when a required binding is missing", async () => {
    const needsQueue = defineCapability({
      name: "needsMissing",
      requiredBindings: [{ type: "kv", name: "DOES_NOT_EXIST", optional: false }],
    });
    const app = createBackend({ capabilities: [needsQueue] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: kv:DOES_NOT_EXIST/);
  });

  test("defaults c.var.auth to null", async () => {
    const whoami = defineCapability({
      name: "whoami",
      requiredBindings: [],
      routes: (a) => {
        a.get("/whoami", (c) => c.json({ auth: c.get("auth") }));
      },
    });
    const app = createBackend({ capabilities: [whoami] });
    const res = await app.request("/whoami", {}, env);
    expect(await res.json()).toEqual({ auth: null });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run --filter @pithy-sh/core test`
Expected: FAIL — `Cannot find module './createBackend'`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/@pithy-sh/core/src/createBackend.ts
import { Hono } from "hono";
import type { BindingSpec } from "./bindings";
import type { Capability, PithyHonoEnv } from "./capability";
import { validateBindings } from "./validateBindings";

export interface AppCapability {
  routes?: (app: Hono<PithyHonoEnv>) => void;
  requiredBindings?: BindingSpec[];
}

export interface CreateBackendOptions {
  capabilities: Capability[];
  app?: AppCapability;
}

/**
 * Assemble capabilities into a deployable Hono app (a valid Worker fetch handler).
 * Binding validation runs once on the first request (env is per-request in Workers).
 */
export function createBackend(options: CreateBackendOptions): Hono<PithyHonoEnv> {
  const app = new Hono<PithyHonoEnv>();

  const required: BindingSpec[] = [
    ...options.capabilities.flatMap((c) => c.requiredBindings),
    ...(options.app?.requiredBindings ?? []),
  ];

  let validated = false;
  app.use("*", async (c, next) => {
    if (!validated) {
      validateBindings(c.env as Record<string, unknown>, required);
      validated = true;
    }
    // default request context
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });

  // health endpoint
  app.get("/health", (c) => c.json({ status: "ok" }));

  // compose capability middleware, then mount routes
  for (const cap of options.capabilities) {
    for (const mw of cap.middleware ?? []) mw(app);
  }
  for (const cap of options.capabilities) {
    cap.routes?.(app);
  }
  options.app?.routes?.(app);

  return app;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun run --filter @pithy-sh/core test`
Expected: PASS — all four `createBackend` tests green. (Hono's `onError` returns 500 with the thrown message as text by default, satisfying the fail-fast test. If the body isn't the message, add `app.onError((err, c) => c.text(err.message, 500))` before returning `app`.)

- [ ] **Step 6: Typecheck + full test sweep**

Run: `bun run --filter @pithy-sh/core typecheck && bun run --filter @pithy-sh/core test`
Expected: PASS both (node + Workers projects).

- [ ] **Step 7: Commit**

```bash
git add packages/@pithy-sh/core/src/capability.ts packages/@pithy-sh/core/src/createBackend.ts packages/@pithy-sh/core/src/createBackend.workers.test.ts
git commit -m "feat(core): add createBackend Hono app factory"
```

---

## Self-Review

**1. Spec coverage:** Config loader (§7/§8.2) — Task 2 ✅. Fail-fast binding validation (§7) — Tasks 3, 7 ✅ (implemented as first-request middleware, with the Workers per-request `env` nuance handled). Typed KV with namespaced keys + explicit TTL (§KV) — Task 5 ✅. Kysely `PithyDatabase` via master Zod map `z.input` + `CamelCasePlugin` + `D1Dialect` (§6.4) — Task 6 ✅. Round-trip rule `.parse()`/`.encode()` proven end-to-end (§6.3) — Task 6 ✅. `createBackend` Hono factory mounting capabilities + `/health` (§7/§8) — Task 7 ✅. Workers-runtime tests with real D1/KV via vitest-pool-workers (§Testing) — Tasks 4–7 ✅.

**2. Placeholder scan:** No TBD/TODO. Every code step complete. Two explicit verification notes (vitest-pool-workers config API; Hono onError body) are framed as concrete fallbacks the executor applies if the runtime differs — not deferred work.

**3. Type/name consistency:** `composeConfig`/`loadConfig`, `validateBindings`, `TypedKv`, `createDatabase`/`DatabaseSchema`/`WithGeneratedId`, `createBackend`/`CreateBackendOptions`/`AppCapability` are consistent across tasks. `PithyVars` is extended in Task 1-step (db/kv added) matching the plan-2 note that plan 3 extends it. `Widget`/`PithyDatabaseMap` are test-local examples, not exported API. `BindingSpec` shape (`type`/`name`/`optional`) matches plan 2.

**Deferred to plan 4 (CLI):** running the migration registry against D1 (`pithy migrate`), scaffolding the starter, and `pithy add`. `createBackend` intentionally does not run migrations at request time — migrations are CLI/Workflow-driven (spec §10.10).
